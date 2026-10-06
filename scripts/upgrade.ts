import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spoolCounts } from "../src/adapters/claude/spool.ts";
import { identify, livenessAll, type ProcessIdentity } from "../src/adapters/process.ts";
import { executableBuildInfo, sourceHash } from "../src/build-info.ts";
import type { Resolved } from "../src/config/config.ts";
import { migrateSchema, readSchemaVersion, SCHEMA_VERSION } from "../src/store/db.ts";
import { ensurePrivateDir, writeFileAtomic } from "../src/util/fsx.ts";
import { ROOT } from "./build.ts";

function table(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function assertIdle(db: Database, paths: Resolved): void {
  if (readSchemaVersion(db) > SCHEMA_VERSION)
    throw new Error("Store is newer than this checkout; refusing downgrade");
  if (table(db, "delegations")) {
    const open = db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM delegations WHERE state = 'open'")
      .get()!.n;
    if (open)
      throw new Error(`${open} open delegation(s); finish or deliberately close them before upgrading`);
  }
  if (table(db, "wait_arms")) {
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(wait_arms)").all();
    const rows = db
      .query<{ process: string | null }, []>(
        columns.some((c) => c.name === "process")
          ? "SELECT process FROM wait_arms WHERE ended_at IS NULL"
          : "SELECT NULL AS process FROM wait_arms WHERE ended_at IS NULL",
      )
      .all();
    const identities = rows.map((r): ProcessIdentity => {
      try {
        const value = r.process ? JSON.parse(r.process) : null;
        if (value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.start === "string")
          return { pid: value.pid, start: value.start };
      } catch {
        // Malformed evidence is unverified, never proof of exit.
      }
      return { pid: 0, start: "" };
    });
    if (livenessAll(identities).some((state) => state !== "dead"))
      throw new Error(
        "Active or unverifiable wait(s); stop/reconcile watchers before upgrading (timeouts alone do not prove exit)",
      );
  }
  if (spoolCounts(paths).backlog > 0)
    throw new Error("Pending hook events; run `agentbus event drain` before upgrading");
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Offline upgrade. Files and SQLite cannot share a commit: preserve backups and an interruption journal. */
export function installCandidate(candidate: string, target: string, paths: Resolved) {
  const info = executableBuildInfo(candidate);
  if (!info || info.schemaVersion !== SCHEMA_VERSION || info.sourceHash !== sourceHash(ROOT))
    throw new Error("Candidate does not match this checkout/schema; rebuild before installing");
  const lock = `${target}.upgrade-lock`;
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Upgrade lock exists: ${lock}. Inspect its journal and owner; do not remove it while another upgrade runs. After an interrupted upgrade, stop Agentbus users, inspect build-info/store schema, then remove the lock and rerun upgrade. Backups are never restored automatically.`,
      );
    throw err;
  }
  let db: Database | undefined;
  let installed = false;
  let committed = false;
  let preserveLock = false;
  const stamp = `${Date.now()}-${crypto.randomUUID()}`;
  const owner = identify(process.pid);
  let binaryBackup: string | null = null;
  let storeBackup: string | null = null;
  const journal = (stage: string) =>
    writeFileAtomic(
      join(lock, "journal.json"),
      JSON.stringify(
        {
          stage,
          pid: process.pid,
          owner,
          candidate: info,
          target,
          dbPath: paths.dbPath,
          binaryBackup,
          storeBackup,
        },
        null,
        2,
      ),
    );
  try {
    journal("checking");
    syncFile(dirname(lock));
    if (existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()))
      throw new Error(`Install destination must be a regular executable, not a symlink/directory: ${target}`);
    ensurePrivateDir(paths.stateDir);
    db = new Database(paths.dbPath, { create: true, strict: true });
    chmodSync(paths.dbPath, 0o600);
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA synchronous = FULL");
    const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode;
    if (mode !== "delete")
      throw new Error(`Expected rollback journal mode, found ${mode}; inspect the store before upgrading`);
    db.run("BEGIN EXCLUSIVE");
    assertIdle(db, paths);
    const integrity = db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get()?.integrity_check;
    if (integrity !== "ok") throw new Error(`Store integrity failed: ${integrity}`);
    const version = readSchemaVersion(db);
    if (version > 0) {
      storeBackup = join(paths.stateDir, "backups", `schema-${version}-${stamp}.sqlite3`);
      writeFileAtomic(storeBackup, db.serialize());
      syncFile(paths.stateDir);
    }
    if (existsSync(target)) {
      binaryBackup = `${target}.before-${stamp}`;
      copyFileSync(target, binaryBackup);
      chmodSync(binaryBackup, 0o700);
      syncFile(binaryBackup);
      syncFile(dirname(target));
    }
    journal("prepared");
    const migration = migrateSchema(db);
    ensurePrivateDir(paths.spoolDir);
    ensurePrivateDir(paths.logsDir);
    // Candidate is staged beside the destination, so rename is an atomic same-filesystem replacement.
    syncFile(candidate);
    renameSync(candidate, target);
    installed = true;
    syncFile(dirname(target));
    journal("binary_installed");
    // Process-level release regression check: failure at the file/database commit boundary.
    if (process.env.AGENTBUS_FAULT_INJECT === "upgrade-after-install")
      throw new Error("Injected failure after binary installation");
    if (process.env.AGENTBUS_FAULT_INJECT === "upgrade-after-install-kill")
      process.kill(process.pid, "SIGKILL");
    db.run("COMMIT");
    committed = true;
    return { target, build: info, migration, binaryBackup, storeBackup };
  } catch (err) {
    if (!committed) {
      try {
        if (db?.inTransaction) db.run("ROLLBACK");
        if (installed) {
          if (binaryBackup) {
            // Keep the backup as evidence even after a successful rollback.
            const restore = join(lock, "restore");
            copyFileSync(binaryBackup, restore);
            syncFile(restore);
            renameSync(restore, target);
          } else unlinkSync(target);
          syncFile(dirname(target));
        }
      } catch (rollbackError) {
        preserveLock = true;
        throw new Error(
          `Upgrade failed (${String(err)}); rollback also failed (${String(rollbackError)}). Inspect ${lock}; backups retained.`,
        );
      }
    }
    throw err;
  } finally {
    db?.close();
    if (!preserveLock) {
      if (existsSync(join(lock, "journal.json"))) unlinkSync(join(lock, "journal.json"));
      rmdirSync(lock);
    }
  }
}
