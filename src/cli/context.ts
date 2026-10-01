import type { Command } from "commander";
import pc from "picocolors";
import { type Resolved, resolvePaths } from "../config/config.ts";
import { type AgentbusError, EXIT, usageError } from "../errors.ts";
import { OUTPUT_VERSION } from "../protocol/types.ts";
import { type Db, openStore } from "../store/db.ts";
import { decodeUtf8, readBoundedFile, readBoundedStdin } from "../util/fsx.ts";

export type Mode = "json" | "plain" | "human";

export interface GlobalOptions {
  as?: string;
  config?: string;
  stateDir?: string;
  json?: boolean;
  plain?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
  input?: boolean;
}

/** Per-invocation context: output contract, lazily resolved paths and one database connection. */
export class Ctx {
  readonly opts: GlobalOptions;
  readonly mode: Mode;
  exitCode: number = EXIT.ok;
  private _paths: Resolved | null = null;
  private _db: Db | null = null;
  private emitted = false;

  constructor(opts: GlobalOptions) {
    if (opts.json && opts.plain) throw usageError("--json and --plain are mutually exclusive");
    this.opts = opts;
    this.mode = opts.json ? "json" : opts.plain ? "plain" : "human";
    if (opts.color === false || process.env.NO_COLOR) pc.isColorSupported = false;
  }

  static from(cmd: Command): Ctx {
    return new Ctx(cmd.optsWithGlobals<GlobalOptions>());
  }

  get paths(): Resolved {
    this._paths ??= resolvePaths({ config: this.opts.config, stateDir: this.opts.stateDir });
    return this._paths;
  }

  db(): Db {
    this._db ??= openStore(this.paths);
    return this._db;
  }

  close(): void {
    this._db?.close();
    this._db = null;
  }

  /** stdout carries the primary output only: one JSON object, stable TSV lines, or concise human text. */
  emit(data: unknown, human: () => string, plain?: () => string | string[]): void {
    if (this.emitted) throw new Error("emit called twice");
    this.emitted = true;
    if (this.mode === "json") {
      process.stdout.write(`${JSON.stringify({ schemaVersion: OUTPUT_VERSION, ok: true, data })}\n`);
      return;
    }
    if (this.mode === "plain") {
      const out = plain ? plain() : human();
      const text = Array.isArray(out) ? out.join("\n") : out;
      if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      return;
    }
    if (this.opts.quiet) return;
    const text = human();
    if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  log(message: string): void {
    if (this.opts.verbose) process.stderr.write(`${pc.dim(message)}\n`);
  }

  warn(message: string): void {
    if (!this.opts.quiet || this.opts.verbose) process.stderr.write(`${pc.yellow("warning:")} ${message}\n`);
  }
}

export function emitError(mode: Mode, err: AgentbusError): void {
  if (mode === "json") {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: OUTPUT_VERSION,
        ok: false,
        error: { code: err.code, message: err.message, exitCode: err.exitCode, details: err.details },
      })}\n`,
    );
    return;
  }
  process.stderr.write(`${pc.red("error:")} ${err.message} ${pc.dim(`[${err.code}]`)}\n`);
}

/** All body input comes from a file or `-` (stdin), bounded before decoding and strictly UTF-8. */
export async function readBody(file: string | undefined, limit: number, what = "body"): Promise<string> {
  if (!file) throw usageError(`--file <path|-> is required for the ${what}`);
  const bytes = file === "-" ? await readBoundedStdin(limit, what) : readBoundedFile(file, limit, what);
  return decodeUtf8(bytes, what);
}

export function parseLimit(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw usageError("--limit must be a positive integer");
  if (n > max) throw usageError(`--limit must be at most ${max}`);
  return n;
}

export function parseSequence(value: string | undefined, flag: string): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw usageError(`${flag} must be a non-negative safe integer`);
  return n;
}

export const collect = (value: string, prev: string[] = []): string[] => [...prev, value];
