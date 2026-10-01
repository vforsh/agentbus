// Database contention: hooks stay inside their 1 s budget by spooling; commands fail with exit 6.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, sleep, uuid } from "../harness.ts";

let s: Store;
beforeAll(() => {
  s = new Store().init();
});
afterAll(() => s.cleanup());

/** Holds a SQLite lock from a separate process for `ms` milliseconds. */
async function holdLock(mode: "IMMEDIATE" | "EXCLUSIVE", ms: number) {
  const script = join(s.dir, `lock-${mode}.ts`);
  writeFileSync(
    script,
    `import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(join(s.stateDir, "agentbus.sqlite3"))});
db.run("BEGIN ${mode}");
console.log("locked");
await Bun.sleep(${ms});
db.run("ROLLBACK");`,
  );
  const proc = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  await reader.read();
  return proc;
}

test("a hook blocked by a writer spools within its budget and the event drains later", async () => {
  const leadId = uuid();
  s.register("claude", leadId, "lead");
  const project = join(s.dir, "p");
  mkdirSync(project);
  const d = s.ok(["delegate", "--to", "claude", "--cwd", project, "--file", "-"], {
    as: `claude:${leadId}`,
    input: "t",
  });
  const sid = uuid();
  const prompt = uuid();
  s.hook({
    session_id: sid,
    hook_event_name: "UserPromptSubmit",
    prompt_id: prompt,
    cwd: project,
    prompt: d.contract,
  });

  const lock = await holdLock("IMMEDIATE", 2500);
  const started = Date.now();
  const r = s.hook({
    session_id: sid,
    hook_event_name: "Stop",
    prompt_id: prompt,
    cwd: project,
    last_assistant_message: "blocked final",
    background_tasks: [],
  });
  const elapsed = Date.now() - started;
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(elapsed).toBeLessThan(1900);
  expect(readdirSync(join(s.stateDir, "spool")).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  await lock.exited;

  const notices = s.ok(["read", "--type", "notice"], { as: `claude:${leadId}` }).messages;
  expect(notices.map((m: any) => m.body)).toContain("blocked final");
});

test("a command blocked past its 5 s deadline exits 6 with database_busy", async () => {
  s.register("generic", "busy-a");
  const lock = await holdLock("EXCLUSIVE", 6500);
  const r = await s.runAsync(["send", "generic:busy-a", "--file", "-"], { as: "generic:busy-a", input: "x" });
  expect(r.code).toBe(6);
  expect(r.json?.error.code).toBe("database_busy");
  await lock.exited;
  await sleep(10);
  expect(
    s.ok(["send", "generic:busy-a", "--file", "-"], { as: "generic:busy-a", input: "after" }).messageId,
  ).toBeString();
});
