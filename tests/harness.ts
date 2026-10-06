// Process-level harness: every check drives the public CLI in a subprocess against an isolated store.

import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BIN = resolve(import.meta.dir, "../bin/agentbus");
export const FIXTURES = resolve(import.meta.dir, "fixtures");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  json: { schemaVersion: number; ok: boolean; data?: any; error?: any } | null;
}

export interface RunOptions {
  as?: string;
  input?: string | Uint8Array;
  env?: Record<string, string | undefined>;
  cwd?: string;
  json?: boolean;
}

/** Provider markers from the developer's own session must never leak into checks. */
const SCRUB = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "AGENTBUS_SESSION_ID",
  "AGENTBUS_STATE_DIR",
  "AGENTBUS_CONFIG",
];

export class Store {
  readonly dir: string;
  readonly stateDir: string;
  readonly configPath: string;
  readonly settingsPath: string;

  constructor(config: Record<string, unknown> = {}) {
    this.dir = mkdtempSync(join(tmpdir(), "agentbus-check-"));
    this.stateDir = join(this.dir, "state");
    this.configPath = join(this.dir, "config.json");
    this.settingsPath = join(this.dir, "claude-settings.json");
    writeFileSync(
      this.configPath,
      JSON.stringify({
        claudeSettingsPath: this.settingsPath,
        claudeJobsDir: join(this.dir, "jobs"),
        claudeBin: join(this.dir, "no-claude"),
        codexBin: join(this.dir, "no-codex"),
        ...config,
      }),
    );
  }

  env(extra: Record<string, string | undefined> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SCRUB.includes(k)) env[k] = v;
    env.AGENTBUS_STATE_DIR = this.stateDir;
    env.AGENTBUS_CONFIG = this.configPath;
    // An installed standalone executable must never stand in for the checkout under test.
    env.XDG_DATA_HOME = join(this.dir, "data");
    env.NO_COLOR = "1";
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    return env;
  }

  args(args: string[], opts: RunOptions): string[] {
    const out = [BIN];
    if (opts.as) out.push("--as", opts.as);
    if (opts.json !== false) out.push("--json");
    return [...out, ...args];
  }

  run(args: string[], opts: RunOptions = {}): RunResult {
    const res = Bun.spawnSync(this.args(args, opts), {
      env: this.env(opts.env),
      cwd: opts.cwd ?? this.dir,
      stdin: opts.input !== undefined ? Buffer.from(opts.input as string) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return result(res.exitCode ?? -1, res.stdout.toString(), res.stderr.toString());
  }

  async runAsync(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const proc = Bun.spawn(this.args(args, opts), {
      env: this.env(opts.env),
      cwd: opts.cwd ?? this.dir,
      stdin: opts.input !== undefined ? Buffer.from(opts.input as string) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return result(code, stdout, stderr);
  }

  spawn(args: string[], opts: RunOptions = {}) {
    return Bun.spawn(this.args(args, opts), {
      env: this.env(opts.env),
      cwd: opts.cwd ?? this.dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  /** Runs and requires success, returning `data`. */
  ok(args: string[], opts: RunOptions = {}): any {
    const r = this.run(args, opts);
    if (r.code !== 0 || !r.json?.ok) {
      throw new Error(`agentbus ${args.join(" ")} failed (${r.code}): ${r.stdout}${r.stderr}`);
    }
    return r.json.data;
  }

  init(): this {
    this.ok(["init"]);
    return this;
  }

  register(provider: string, externalId: string, name?: string): string {
    const args = ["session", "register", "--provider", provider, "--external-id", externalId];
    if (name) args.push("--name", name);
    return this.ok(args).sessionId as string;
  }

  /** Sends a hook payload through the silent hook entry point, exactly as Claude would. */
  hook(payload: unknown, env: Record<string, string | undefined> = {}): RunResult {
    const res = Bun.spawnSync(
      [
        BIN,
        "--state-dir",
        this.stateDir,
        "--config",
        this.configPath,
        "event",
        "ingest",
        "--provider",
        "claude",
        "--source",
        "hook",
      ],
      {
        env: this.env(env),
        cwd: this.dir,
        stdin: Buffer.from(JSON.stringify(payload)),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return result(res.exitCode ?? -1, res.stdout.toString(), res.stderr.toString());
  }

  sql<T = any>(query: string, ...params: (string | number)[]): T[] {
    const db = new Database(join(this.stateDir, "agentbus.sqlite3"), { readonly: true });
    try {
      // Wait-arm polling can race a real CLI commit. Match the CLI's bounded contention deadline.
      db.exec("PRAGMA busy_timeout = 5000");
      return db.query(query).all(...params) as T[];
    } finally {
      db.close();
    }
  }

  /** Direct write, only to stage evidence another component (for example a probe) would record. */
  sqlWrite(query: string, ...params: (string | number)[]): void {
    const db = new Database(join(this.stateDir, "agentbus.sqlite3"));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.query(query).run(...params);
    } finally {
      db.close();
    }
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function result(code: number, stdout: string, stderr: string): RunResult {
  let json: RunResult["json"] = null;
  const line = stdout.trim().split("\n").pop();
  if (line?.startsWith("{")) {
    try {
      json = JSON.parse(line);
    } catch {}
  }
  return { code, stdout, stderr, json };
}

export function fixture(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

export const uuid = (): string => crypto.randomUUID();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
