// Public experiment CLI with real subprocess restarts and synthetic app API receipts.
// These checks cannot prove Desktop scheduling, persistence, or resumption.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store, uuid } from "../harness.ts";

const SCRIPT = resolve(import.meta.dir, "../../scripts/heartbeat-restart.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: undefined, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return {
    code: r.exitCode,
    text: r.stderr.toString(),
    data: r.stdout.length ? JSON.parse(r.stdout.toString()) : null,
  };
}
function ok(args: string[]) {
  const r = run(args);
  if (r.code !== 0) throw new Error(r.text);
  return r.data;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbus-heartbeat-"));
  roots.push(root);
  const dir = join(root, "isolated");
  const thread = uuid();
  ok(["prepare", "--fixture", "--dir", dir, "--thread", thread]);
  const manifest = () => JSON.parse(readFileSync(join(dir, "experiment.json"), "utf8"));
  const automation = {
    id: `fixture-${uuid()}`,
    kind: "heartbeat",
    status: "ACTIVE",
    targetThreadId: thread,
    prompt: readFileSync(join(dir, "heartbeat-prompt.txt"), "utf8"),
  };
  const receipt = join(root, "automation.json");
  const saveReceipt = (data: unknown) =>
    writeFileSync(receipt, JSON.stringify({ content: [{ type: "text", text: JSON.stringify(data) }] }));
  saveReceipt({ automation });
  const cmd = (action: string, extra: string[] = []) => [
    action,
    "--dir",
    dir,
    "--receipt",
    receipt,
    ...extra,
  ];
  return { dir, root, thread, manifest, automation, receipt, saveReceipt, cmd };
}

describe("Codex heartbeat restart experiment (fixture evidence only)", () => {
  test("a competing handler cannot consume mail; killing it releases the lock for recovery", async () => {
    const f = fixture();
    ok(f.cmd("bind"));
    const lock = join(f.dir, "handler-lock.sqlite3");
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        "import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1], {create: true}); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setInterval(() => db.query('SELECT 1').get(), 1000);",
        lock,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(first.value)).toContain("locked");
      expect(run(f.cmd("tick"))).toMatchObject({ code: 1 });
      expect(ok(["status", "--dir", f.dir])).toMatchObject({ handled: 0, pending: 53 });
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
    expect(ok(f.cmd("tick"))).toMatchObject({ recovered: 53, cleanupReady: false });
    expect(readdirSync(join(f.dir, "handled"))).toHaveLength(53);
  });

  test("actual card-only API receipt shapes use read-only fixture config; prose is never treated as metadata", () => {
    const f = fixture();
    const create = {
      content: [
        { type: "text", text: "Created automation in the app." },
        {
          type: "text",
          text: JSON.stringify({ automationId: f.automation.id, mode: "create", status: "ACTIVE" }),
        },
      ],
    };
    writeFileSync(f.receipt, JSON.stringify(create));
    ok(f.cmd("created"));
    const view = {
      content: [{ type: "text", text: "Rendered automation card in the app." }],
      isError: false,
    };
    writeFileSync(f.receipt, JSON.stringify(view));
    expect(run(f.cmd("bind")).text).toContain("rendered cards are not metadata");
    expect(run(f.cmd("capture-view")).text).toContain("isolated config");
    const config = join(f.root, "automation-fixture.toml");
    writeFileSync(
      config,
      Object.entries({ ...f.automation, target_thread_id: f.thread })
        .filter(([k]) => k !== "targetThreadId")
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join("\n"),
    );
    const evidence = ok(f.cmd("capture-view", ["--fixture-config", config])).evidence;
    ok(["bind", "--dir", f.dir, "--receipt", evidence]);
    expect(ok(["tick", "--dir", f.dir, "--receipt", evidence])).toMatchObject({
      recovered: 53,
      cleanupReady: false,
    });
    writeFileSync(
      f.receipt,
      JSON.stringify({
        content: [
          { type: "text", text: "Deleted automation in the app." },
          {
            type: "text",
            text: JSON.stringify({ automationId: f.automation.id, mode: "delete", deleteStatus: "deleted" }),
          },
        ],
      }),
    );
    ok(f.cmd("cleanup", ["--abort"]));
    expect(ok(["status", "--dir", f.dir])).toMatchObject({
      cleanup: "aborted",
      restart: null,
      acceptance: "fixture_only",
    });
  });

  test("subprocess restart recovers unread and seen mail in multiple pages; cleanup waits for the last delegation", () => {
    const f = fixture();
    ok(f.cmd("bind"));
    expect(f.manifest().automationId).toBe(f.automation.id);
    const first = ok(f.cmd("tick"));
    expect(first).toMatchObject({ recovered: 53, pages: 2, cleanupReady: false });
    expect(ok(["status", "--dir", f.dir])).toMatchObject({
      handled: 53,
      pending: 0,
      restart: null,
      acceptance: "fixture_only",
    });
    // Another fresh process starts its sweep at zero, and finds no already-acknowledged mail.
    expect(ok(f.cmd("tick"))).toMatchObject({ recovered: 0, cleanupReady: false });
    f.saveReceipt({ id: f.automation.id, deleted: true });
    expect(run(f.cmd("cleanup")).text).toContain("all delegations ended");
    f.saveReceipt({ automation: f.automation });
    ok(["finish-worker", "--dir", f.dir]);
    ok(["finish-worker", "--dir", f.dir]); // Keyed producer retry; no second result.
    expect(ok(f.cmd("tick"))).toMatchObject({ recovered: 1, cleanupReady: true });
    expect(readdirSync(join(f.dir, "handled"))).toHaveLength(54);
    f.saveReceipt({ id: f.automation.id, deleted: true });
    ok(f.cmd("cleanup"));
    ok(f.cmd("cleanup"));
    expect(ok(["status", "--dir", f.dir])).toMatchObject({ cleanup: "complete", pending: 0 });
    // The retained history distinguishes parent acknowledgement from automatic settlement.
    const m = f.manifest();
    const s = new Store();
    try {
      const r = s.ok(["--config", m.config, "--state-dir", m.stateDir, "session", "show", m.parent]);
      expect(r.session.returnBinding).toMatchObject({ status: "setup_required", handle: null });
    } finally {
      s.cleanup();
    }
  });

  test("interruption after a side effect recovers the old unacknowledged message without duplicating handling", () => {
    const f = fixture();
    ok(f.cmd("bind"));
    expect(run(f.cmd("tick", ["--interrupt-after-handle"]))).toMatchObject({ code: 1 });
    expect(ok(["status", "--dir", f.dir])).toMatchObject({ handled: 1, pending: 53 });
    expect(ok(f.cmd("tick"))).toMatchObject({ recovered: 53, pages: 2 });
    expect(readdirSync(join(f.dir, "handled"))).toHaveLength(53);
    expect(ok(["status", "--dir", f.dir])).toMatchObject({ pending: 0, acceptance: "fixture_only" });
    // Lost durable handling evidence prevents cleanup even when receipts were already acknowledged.
    rmSync(join(f.dir, "handled", `${f.manifest().results.seen}.json`));
    expect(run(["finish-worker", "--dir", f.dir]).text).toContain("without durable handling");
  });

  test("wrong chat, paused/cron/changed automation, and absent tools cannot refresh or consume prepared mail", () => {
    const f = fixture();
    for (const patch of [
      { targetThreadId: uuid() },
      { status: "PAUSED" },
      { kind: "cron" },
      { prompt: "different intent" },
    ]) {
      f.saveReceipt({ automation: { ...f.automation, ...patch } });
      expect(run(f.cmd("bind")).code).toBe(1);
      expect(ok(["status", "--dir", f.dir])).toMatchObject({ pending: 53, automationId: null });
    }
    f.saveReceipt({ automation: f.automation });
    ok(f.cmd("bind"));
    f.saveReceipt({ automation: { ...f.automation, id: "another-heartbeat" } });
    expect(run(f.cmd("tick")).text).toContain("Different automation ID");
    // A manifest marked live still cannot turn a wrong native caller into original-chat evidence.
    const m = f.manifest();
    writeFileSync(join(f.dir, "experiment.json"), JSON.stringify({ ...m, mode: "live" }));
    expect(run(f.cmd("tick"), { CODEX_THREAD_ID: uuid() }).text).toContain("Original-chat mismatch");
    expect(run(["prepare", "--dir", join(f.root, "headless"), "--thread", uuid()]).text).toContain(
      "original native chat",
    );
    expect(run(["prepare", "--fixture", "--dir", f.dir, "--thread", f.thread]).text).toContain(
      "existing paths",
    );
  });

  test("cancel cleans only its own disposable resources and records an aborted, unpassed experiment", () => {
    const f = fixture();
    ok(f.cmd("bind"));
    f.saveReceipt({ id: "unrelated", deleted: true });
    expect(run(f.cmd("cleanup", ["--abort"])).code).toBe(1);
    expect(ok(["status", "--dir", f.dir])).toMatchObject({ pending: 53 });
    f.saveReceipt({ id: f.automation.id, deleted: true });
    ok(f.cmd("cleanup", ["--abort"]));
    expect(ok(["status", "--dir", f.dir])).toMatchObject({
      cleanup: "aborted",
      pending: 0,
      restart: null,
      acceptance: "fixture_only",
    });
  });
});
