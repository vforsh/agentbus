import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import type { Resolved } from "../config/config.ts";
import { AgentbusError, EXIT, failure } from "../errors.ts";
import { ensurePrivateDir, fileExists } from "../util/fsx.ts";
import { nowIso } from "../util/misc.ts";
import m001 from "./migrations/001_mailbox.sql" with { type: "text" };
import m002 from "./migrations/002_observations.sql" with { type: "text" };
import m003 from "./migrations/003_handoff.sql" with { type: "text" };
import m004 from "./migrations/004_settlement.sql" with { type: "text" };

export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  { version: 1, name: "mailbox", sql: m001 },
  { version: 2, name: "observations", sql: m002 },
  { version: 3, name: "handoff", sql: m003 },
  { version: 4, name: "settlement", sql: m004 },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
export const SYSTEM_OBSERVER_ID = "00000000-0000-4000-8000-000000000000";

export const COMMAND_BUSY_MS = 5000;
export const HOOK_BUSY_MS = 1000;

export type Db = Database;

export interface OpenOptions {
  readonly?: boolean;
  busyMs?: number;
}

function configure(db: Database, busyMs: number, writable: boolean): void {
  db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyMs))}`);
  if (writable) {
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA synchronous = FULL");
  }
}

export function readSchemaVersion(db: Database): number {
  const hasTable = db
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (!hasTable || hasTable.n === 0) return 0;
  const row = db.query<{ v: number | null }, []>("SELECT max(version) AS v FROM schema_migrations").get();
  return row?.v ?? 0;
}

/** Opens an initialized store; refuses missing, older or newer schemas without repairing anything. */
export function openStore(paths: Resolved, opts: OpenOptions = {}): Database {
  if (!fileExists(paths.dbPath)) {
    throw new AgentbusError(
      "store_not_initialized",
      `No mailbox at ${paths.dbPath}; run \`agentbus init\` first`,
      EXIT.notFound,
      { dbPath: paths.dbPath },
    );
  }
  const readonly = opts.readonly ?? false;
  const db = readonly
    ? new Database(paths.dbPath, { readonly: true, strict: true })
    : new Database(paths.dbPath, { readwrite: true, create: false, strict: true });
  try {
    configure(db, opts.busyMs ?? COMMAND_BUSY_MS, !readonly);
    const version = readSchemaVersion(db);
    if (version !== SCHEMA_VERSION) {
      const hint =
        version < SCHEMA_VERSION
          ? "run `agentbus init` to migrate it forward"
          : "this agentbus build is older than the store; upgrade agentbus";
      throw new AgentbusError(
        "schema_mismatch",
        `Mailbox schema version ${version} does not match supported version ${SCHEMA_VERSION}; ${hint}`,
        EXIT.failure,
        { found: version, supported: SCHEMA_VERSION },
      );
    }
    const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode;
    if (mode?.toLowerCase() !== "delete") {
      throw failure(
        "journal_mode_mismatch",
        `Mailbox journal mode is ${mode}; expected delete. Re-run \`agentbus init\`.`,
      );
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export interface InitResult {
  created: boolean;
  fromVersion: number;
  toVersion: number;
  applied: number[];
  dbPath: string;
}

/** Creates the store or migrates it forward; idempotent and serialized by an immediate transaction. */
export function initStore(paths: Resolved): InitResult {
  ensurePrivateDir(paths.stateDir);
  ensurePrivateDir(paths.spoolDir);
  ensurePrivateDir(paths.logsDir);
  const created = !fileExists(paths.dbPath);
  const db = new Database(paths.dbPath, { readwrite: true, create: true, strict: true });
  try {
    chmodSync(paths.dbPath, 0o600);
    configure(db, COMMAND_BUSY_MS, true);
    const journal = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE")
      .get()?.journal_mode;
    if (journal?.toLowerCase() !== "delete") {
      throw failure("journal_mode_mismatch", `Could not set rollback journal mode (got ${journal})`);
    }
    const applied: number[] = [];
    let fromVersion = 0;
    const migrate = db.transaction(() => {
      db.run(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
      );
      fromVersion = readSchemaVersion(db);
      if (fromVersion > SCHEMA_VERSION) {
        throw new AgentbusError(
          "schema_mismatch",
          `Mailbox schema version ${fromVersion} is newer than this build (${SCHEMA_VERSION}); upgrade agentbus`,
          EXIT.failure,
          { found: fromVersion, supported: SCHEMA_VERSION },
        );
      }
      for (const m of MIGRATIONS) {
        if (m.version <= fromVersion) continue;
        db.run(m.sql);
        db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
          m.version,
          m.name,
          nowIso(),
        );
        applied.push(m.version);
      }
    });
    migrate.immediate();
    const fk = db.query("PRAGMA foreign_key_check").all();
    if (fk.length > 0)
      throw failure("integrity_failed", "Foreign key check failed after migration", { rows: fk.length });
    const integrity = db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get()?.integrity_check;
    if (integrity !== "ok") throw failure("integrity_failed", `Integrity check failed: ${integrity}`);
    return { created, fromVersion, toVersion: SCHEMA_VERSION, applied, dbPath: paths.dbPath };
  } finally {
    db.close();
  }
}

/** Runs `fn` inside BEGIN IMMEDIATE so read-then-write checks and writes share one transaction. */
export function tx<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function dataVersion(db: Database): number {
  return db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0;
}
