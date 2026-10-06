import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executableBuildInfo } from "../src/build-info.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/store/db.ts";

// Process-boundary checks: no models, real user settings or real mailbox. Also used before installation.
export function isolatedEnv(dir: string): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of [
    "AGENTBUS_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "AGENTBUS_FAULT_INJECT",
  ])
    delete env[key];
  Object.assign(env, {
    AGENTBUS_STATE_DIR: join(dir, "state"),
    AGENTBUS_CONFIG: join(dir, "config.json"),
    XDG_DATA_HOME: join(dir, "data"),
    NO_COLOR: "1",
  });
  writeFileSync(
    env.AGENTBUS_CONFIG!,
    JSON.stringify({
      claudeSettingsPath: join(dir, "claude-settings.json"),
      claudeJobsDir: join(dir, "jobs"),
      claudeBin: join(dir, "no-claude"),
      codexBin: join(dir, "no-codex"),
    }),
  );
  return env;
}

/** A previous schema with durable mail: fixtures use actual migration SQL, never edited current tables. */
export function seedLegacy(path: string, version = SCHEMA_VERSION - 1): void {
  const db = new Database(path);
  try {
    db.run(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
      db.run(m.sql);
      db.query("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    }
    for (const id of ["sender", "receiver"])
      db.query(
        "INSERT INTO sessions (id, provider, external_id, created_at, updated_at) VALUES (?, 'generic', ?, ?, ?)",
      ).run(id, id, new Date().toISOString(), new Date().toISOString());
    db.run(
      "INSERT INTO messages (id, schema_version, from_id, to_id, type, body, created_at, correlation_id) VALUES ('saved-mail', 1, 'sender', 'receiver', 'message', 'survives migration', '2026-01-01', 'saved-mail')",
    );
    db.run(
      "INSERT INTO receipts (message_id, recipient_id, sequence) SELECT id, to_id, sequence FROM messages",
    );
  } finally {
    db.close();
  }
}

export function smoke(binary: string): void {
  assert.equal(executableBuildInfo(binary)?.schemaVersion, SCHEMA_VERSION, "candidate build identity");
  const dir = mkdtempSync(join(tmpdir(), "agentbus-compiled-"));
  try {
    const env = isolatedEnv(dir);
    const run = (args: string[], input?: string, code = 0, executable = binary) => {
      const r = Bun.spawnSync([executable, ...args, "--json"], {
        env,
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        stdin: input === undefined ? "ignore" : Buffer.from(input),
        timeout: 15_000,
      });
      assert.equal(r.exitCode, code, `${args.join(" ")}: ${r.stdout} ${r.stderr}`);
      const receipt = JSON.parse(r.stdout.toString());
      return receipt.data ?? receipt.error;
    };
    run(["init"]);
    run(["doctor"]);
    const parent = `generic:smoke-parent`;
    run(["session", "register", "--provider", "generic", "--external-id", "smoke-parent"]);
    const delegate = (key: string) =>
      run(
        ["--as", parent, "delegate", "--to", "claude", "--cwd", dir, "--key", key, "--file", "-"],
        "smoke task",
      );
    const d = delegate("smoke-task");
    assert.equal(delegate("smoke-task").requestId, d.requestId, "keyed retry");
    const sid = crypto.randomUUID();
    const promptId = crypto.randomUUID();
    const settings = JSON.parse(readFileSync(d.claudeSettings, "utf8"));
    const hook = (event: string, fields: Record<string, unknown>) => {
      const command = settings.hooks[event][0].hooks[0].command;
      assert.ok(command.includes(binary), "hook must pin the compiled candidate");
      const r = Bun.spawnSync(["/bin/sh", "-c", command], {
        env,
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        stdin: Buffer.from(
          JSON.stringify({
            hook_event_name: event,
            session_id: sid,
            prompt_id: promptId,
            cwd: dir,
            ...fields,
          }),
        ),
        timeout: 15_000,
      });
      assert.equal(r.exitCode, 0);
      return r.stdout.toString();
    };
    assert.equal(hook("UserPromptSubmit", { prompt: d.contract }), "");
    assert.equal(
      run(["read", "--correlation", d.requestId], undefined, 0, d.workerBin).messages[0].body,
      "smoke task",
    );
    run(["ack", d.requestId], undefined, 0, d.workerBin);
    const followup = run(["--as", parent, "followup", d.requestId, "--file", "-"], "Use staging");
    assert.ok(hook("PostToolUse", {}).includes(followup.messageId), "compiled doorbell delivers follow-up");
    const result = [
      "reply",
      d.requestId,
      "--type",
      "result",
      "--outcome",
      "success",
      "--key",
      "smoke-result",
      "--file",
      "-",
    ];
    assert.equal(run(result, "done", 5, d.workerBin).code, "followups_pending");
    run(["ack", followup.messageId], undefined, 0, d.workerBin);
    run(result, "done", 0, d.workerBin);
    assert.equal(
      hook("Stop", { last_assistant_message: "done", background_tasks: [], session_crons: [] }),
      "",
    );
    const inbox = run(["--as", parent, "read"]);
    assert.equal(inbox.messages.length, 1, "result suppresses redundant Stop notice");
    assert.equal(inbox.messages[0].outcome, "success");
    run(["--as", parent, "ack", inbox.messages[0].id]);

    // The executable must contain its migrations and preserve pending mail during an upgrade.
    env.AGENTBUS_STATE_DIR = join(dir, "legacy");
    mkdirSync(env.AGENTBUS_STATE_DIR);
    seedLegacy(join(env.AGENTBUS_STATE_DIR, "agentbus.sqlite3"));
    assert.equal(run(["--as", "generic:receiver", "read"], undefined, 1).code, "schema_mismatch");
    assert.equal(run(["init"]).toVersion, SCHEMA_VERSION);
    assert.equal(run(["--as", "generic:receiver", "read"]).messages[0].body, "survives migration");
    assert.deepEqual(run(["init"]).applied, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
