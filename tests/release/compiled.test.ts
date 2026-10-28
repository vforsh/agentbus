import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "../../scripts/build.ts";
import { isolatedEnv, seedLegacy } from "../../scripts/smoke.ts";
import { SCHEMA_VERSION } from "../../src/store/db.ts";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentbus-release-test-"));
  dirs.push(dir);
  const env = isolatedEnv(dir);
  const target = join(env.XDG_DATA_HOME!, "agentbus", "bin", "agentbus");
  const dbPath = join(env.AGENTBUS_STATE_DIR!, "agentbus.sqlite3");
  const legacy = (version = SCHEMA_VERSION - 1) => {
    mkdirSync(dirname(dbPath), { recursive: true });
    seedLegacy(dbPath, version);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "#!/bin/sh\nprintf 'old executable\\n'\n", { mode: 0o700 });
  };
  const cli = (args: string[], source = false) =>
    Bun.spawnSync(
      source ? [process.execPath, join(ROOT, "src/main.ts"), ...args, "--json"] : [target, ...args, "--json"],
      { env, cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 15_000 },
    );
  const release = (mode = "upgrade", root = ROOT, args: string[] = []) =>
    Bun.spawnSync([process.execPath, join(root, "scripts/release.ts"), mode, ...args], {
      env,
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
    });
  return { dir, env, target, dbPath, legacy, cli, release };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function schema(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ v: number }, []>("SELECT max(version) AS v FROM schema_migrations").get()!.v;
  } finally {
    db.close();
  }
}

function success(r: ReturnType<typeof Bun.spawnSync>) {
  expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout!.toString());
}

describe("compiled release gate", () => {
  test("builds and exercises the standalone CLI without creating the selected user store", () => {
    const f = fixture();
    const receipt = success(f.release("check"));
    expect(receipt.build.compiled).toBe(true);
    expect(receipt.build.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.build.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(receipt.build.schemaVersion).toBe(SCHEMA_VERSION);
    expect(existsSync(f.dbPath)).toBe(false);
    expect(existsSync(f.target)).toBe(false);
  });

  test("first installation initializes the chosen store and reports embedded build identity", () => {
    const f = fixture();
    const receipt = success(f.release());
    expect(receipt.migration.toVersion).toBe(SCHEMA_VERSION);
    expect(receipt.binaryBackup).toBeNull();
    expect(receipt.storeBackup).toBeNull();
    const info = success(f.cli(["build-info"])).data;
    expect(info).toEqual(receipt.build);
    expect(info.builtAt).toBeString();
    const doctor = success(f.cli(["doctor"])).data;
    expect(doctor.checks.find((c: any) => c.name === "worker_cli").status).toBe("ok");
    expect(existsSync(`${f.target}.upgrade-lock`)).toBe(false);
  });

  for (const version of [1, SCHEMA_VERSION - 1]) {
    test(`upgrades schema ${version} with recoverable backups and preserves unacknowledged mail`, () => {
      const f = fixture();
      f.legacy(version);
      const oldBinary = readFileSync(f.target);
      const receipt = success(f.release());
      expect(receipt.migration.fromVersion).toBe(version);
      expect(schema(f.dbPath)).toBe(SCHEMA_VERSION);
      expect(schema(receipt.storeBackup)).toBe(version);
      expect(readFileSync(receipt.binaryBackup)).toEqual(oldBinary);
      expect(statSync(receipt.storeBackup).mode & 0o777).toBe(0o600);
      expect(statSync(f.target).mode & 0o777).toBe(0o700);
      const inbox = success(f.cli(["--as", "generic:receiver", "read"])).data;
      expect(inbox.messages[0].body).toBe("survives migration");
      expect(inbox.messages[0].acknowledgedAt).toBeNull();
    });
  }

  test("doctor detects changed bytes even when timestamps are preserved; missing checkout stays unverified", () => {
    const f = fixture();
    const checkout = join(f.dir, "checkout");
    mkdirSync(checkout);
    for (const name of ["src", "scripts", "package.json", "bun.lock", "tsconfig.json"])
      cpSync(join(ROOT, name), join(checkout, name), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(checkout, "node_modules"));
    success(f.release("upgrade", checkout));
    const src = join(checkout, "src/main.ts");
    const before = statSync(src);
    writeFileSync(src, `${readFileSync(src, "utf8")}\n// changed after compilation\n`);
    utimesSync(src, before.atime, before.mtime);
    let checks = success(f.cli(["doctor"])).data.checks;
    expect(checks.find((c: any) => c.name === "worker_cli").message).toContain("checkout stale");
    expect(checks.find((c: any) => c.name === "worker_cli").status).toBe("warn");
    rmSync(checkout, { recursive: true });
    checks = success(f.cli(["doctor"])).data.checks;
    expect(checks.find((c: any) => c.name === "worker_cli").message).toContain("checkout unavailable");
    expect(success(f.cli(["build-info"])).data.compiled).toBe(true);
  });
});

describe("offline upgrade refusals and rollback", () => {
  test("explicit store/config flags override environment without touching another mailbox", () => {
    const f = fixture();
    f.legacy(SCHEMA_VERSION);
    const before = readFileSync(f.dbPath);
    const selected = join(f.dir, "selected store");
    const config = join(f.dir, "selected config.json");
    writeFileSync(config, "{}");
    const r = success(f.release("upgrade", ROOT, ["--state-dir", selected, "--config", config]));
    expect(r.migration.fromVersion).toBe(0);
    expect(schema(join(selected, "agentbus.sqlite3"))).toBe(SCHEMA_VERSION);
    expect(readFileSync(f.dbPath)).toEqual(before);
  });

  test("pending hook captures must be drained before an upgrade", () => {
    const f = fixture();
    f.legacy();
    const spool = join(f.env.AGENTBUS_STATE_DIR!, "spool");
    mkdirSync(spool);
    writeFileSync(join(spool, "pending.json"), "{}");
    const r = f.release();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("Pending hook events");
    expect(schema(f.dbPath)).toBe(SCHEMA_VERSION - 1);
    expect(readFileSync(f.target, "utf8")).toContain("old executable");
    expect(readFileSync(join(spool, "pending.json"), "utf8")).toBe("{}");
  });

  test("migration failure leaves the old executable and original schema usable for diagnosis", () => {
    const f = fixture();
    f.legacy();
    const db = new Database(f.dbPath);
    // Fail the transaction independently of its DDL, so this fixture survives new schema versions.
    db.run(`CREATE TRIGGER fail_migration BEFORE INSERT ON schema_migrations
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
    db.close();
    const before = readFileSync(f.dbPath);
    const r = f.release();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("injected migration failure");
    expect(schema(f.dbPath)).toBe(SCHEMA_VERSION - 1);
    expect(readFileSync(f.dbPath)).toEqual(before);
    expect(readFileSync(f.target, "utf8")).toContain("old executable");
  });

  test("open delegations leave the existing executable and mailbox unchanged", () => {
    const f = fixture();
    f.legacy(SCHEMA_VERSION);
    const r = Bun.spawnSync(
      [
        process.execPath,
        join(ROOT, "src/main.ts"),
        "--as",
        "generic:sender",
        "delegate",
        "--to",
        "codex",
        "--file",
        "-",
        "--json",
      ],
      { env: f.env, cwd: f.dir, stdin: Buffer.from("working"), stdout: "pipe", stderr: "pipe" },
    );
    success(r);
    const before = readFileSync(f.dbPath);
    const binary = readFileSync(f.target);
    const upgrade = f.release();
    expect(upgrade.exitCode).toBe(1);
    expect(upgrade.stderr.toString()).toContain("open delegation");
    expect(readFileSync(f.dbPath)).toEqual(before);
    expect(readFileSync(f.target)).toEqual(binary);
  });

  test("a running watcher blocks upgrade even without an open delegation", async () => {
    const f = fixture();
    f.legacy(SCHEMA_VERSION);
    success(f.cli(["--as", "generic:receiver", "ack", "saved-mail"], true));
    const waiter = Bun.spawn(
      [
        process.execPath,
        join(ROOT, "src/main.ts"),
        "--as",
        "generic:receiver",
        "wait",
        "--timeout",
        "60s",
        "--json",
      ],
      { env: f.env, cwd: f.dir, stdout: "pipe", stderr: "pipe" },
    );
    try {
      let armed = false;
      for (let n = 0; n < 100; n++) {
        const db = new Database(f.dbPath, { readonly: true });
        db.run("PRAGMA busy_timeout = 5000");
        armed = !!db.query("SELECT 1 FROM wait_arms WHERE ended_at IS NULL").get();
        db.close();
        if (armed) break;
        await Bun.sleep(20);
      }
      expect(armed).toBe(true);
      const r = f.release();
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("Active or unverifiable wait");
      expect(readFileSync(f.target, "utf8")).toContain("old executable");
    } finally {
      waiter.kill();
      await waiter.exited;
    }
  });

  test("legacy wait arms without process evidence are not assumed dead", () => {
    const f = fixture();
    f.legacy();
    const db = new Database(f.dbPath);
    db.run(
      "INSERT INTO wait_arms (id, session_id, created_at) VALUES ('unverified', 'receiver', '2020-01-01')",
    );
    db.close();
    const r = f.release();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("unverifiable wait");
    expect(schema(f.dbPath)).toBe(SCHEMA_VERSION - 1);
  });

  test("a newer schema is refused without replacing the binary", () => {
    const f = fixture();
    f.legacy(SCHEMA_VERSION);
    const db = new Database(f.dbPath);
    db.query("INSERT INTO schema_migrations VALUES (?, 'future', '2026-01-01')").run(SCHEMA_VERSION + 1);
    db.close();
    const before = readFileSync(f.dbPath);
    const r = f.release();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("refusing downgrade");
    expect(readFileSync(f.dbPath)).toEqual(before);
    expect(readFileSync(f.target, "utf8")).toContain("old executable");
  });

  test("failure after replacing the executable restores it and rolls back the migration", () => {
    const f = fixture();
    f.legacy();
    f.env.AGENTBUS_FAULT_INJECT = "upgrade-after-install";
    const binary = readFileSync(f.target);
    const r = f.release();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("Injected failure after binary installation");
    expect(readFileSync(f.target)).toEqual(binary);
    expect(schema(f.dbPath)).toBe(SCHEMA_VERSION - 1);
    expect(existsSync(`${f.target}.upgrade-lock`)).toBe(false);
    delete f.env.AGENTBUS_FAULT_INJECT;
    success(f.release());
    expect(schema(f.dbPath)).toBe(SCHEMA_VERSION);
  });

  test("a killed upgrader retains its journal and backups, refuses retry, then recovers forward without losing mail", () => {
    const f = fixture();
    f.legacy();
    const oldBinary = readFileSync(f.target);
    f.env.AGENTBUS_FAULT_INJECT = "upgrade-after-install-kill";
    const interrupted = f.release();
    expect(interrupted.exitCode).not.toBe(0);
    delete f.env.AGENTBUS_FAULT_INJECT;
    const lock = `${f.target}.upgrade-lock`;
    const journalBytes = readFileSync(join(lock, "journal.json"));
    const journal = JSON.parse(journalBytes.toString());
    expect(journal.stage).toBe("binary_installed");
    expect(readFileSync(journal.binaryBackup)).toEqual(oldBinary);
    expect(schema(journal.storeBackup)).toBe(SCHEMA_VERSION - 1);
    expect(success(f.cli(["build-info"])).data.compiled).toBe(true);

    // Opening the writable CLI connection recovers SQLite's hot rollback journal after process death.
    const read = f.cli(["--as", "generic:receiver", "read"]);
    expect(read.exitCode).toBe(1);
    expect(JSON.parse(read.stdout.toString()).error.code).toBe("schema_mismatch");
    expect(schema(f.dbPath)).toBe(SCHEMA_VERSION - 1);
    const refused = f.release();
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain("Upgrade lock exists");
    expect(readFileSync(join(lock, "journal.json"))).toEqual(journalBytes);

    // The recorded upgrader has exited; remove only its lock and follow the documented forward recovery.
    rmSync(lock, { recursive: true });
    success(f.release());
    expect(schema(f.dbPath)).toBe(SCHEMA_VERSION);
    const inbox = success(f.cli(["--as", "generic:receiver", "read"])).data;
    expect(inbox.messages[0].body).toBe("survives migration");
    expect(inbox.messages[0].acknowledgedAt).toBeNull();
    expect(readFileSync(journal.binaryBackup)).toEqual(oldBinary);
    expect(existsSync(lock)).toBe(false);
  });

  test("a competing database writer prevents installation", () => {
    const f = fixture();
    f.legacy();
    const db = new Database(f.dbPath);
    db.run("BEGIN IMMEDIATE");
    try {
      const r = f.release();
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("locked");
      expect(readFileSync(f.target, "utf8")).toContain("old executable");
    } finally {
      db.run("ROLLBACK");
      db.close();
    }
    expect(schema(f.dbPath)).toBe(SCHEMA_VERSION - 1);
  });

  test("an existing upgrade lock is preserved for inspection", () => {
    const f = fixture();
    f.legacy();
    const lock = `${f.target}.upgrade-lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, "journal.json"), "interrupted upgrade evidence");
    const r = f.release();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("Upgrade lock exists");
    expect(readFileSync(join(lock, "journal.json"), "utf8")).toBe("interrupted upgrade evidence");
  });
});
