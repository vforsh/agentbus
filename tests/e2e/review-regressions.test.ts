// Regression checks for defects found in the adversarial review: ordering, attribution and probes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, sleep, uuid } from "../harness.ts";

let s: Store;
let project: string;
let agentsFile: string;
const LEAD_ID = uuid();
const LEAD = `claude:${LEAD_ID}`;
const procs: ReturnType<typeof Bun.spawn>[] = [];

beforeAll(() => {
  const tmp = new Store();
  agentsFile = join(tmp.dir, "agents.json");
  const fake = join(tmp.dir, "fake-claude");
  writeFileSync(fake, `#!/bin/sh\ncat "${agentsFile}"\n`);
  chmodSync(fake, 0o755);
  writeFileSync(agentsFile, "[]");
  s = new Store({ claudeBin: fake }).init();
  project = join(s.dir, "project");
  mkdirSync(project);
  s.register("claude", LEAD_ID, "lead");
});
afterAll(() => {
  for (const p of procs) p.kill();
  s.cleanup();
});

const spoolDir = () => join(s.stateDir, "spool");
const spooled = () => readdirSync(spoolDir()).filter((f) => f.endsWith(".json"));
function worker(name: string) {
  const d = s.ok(["delegate", "--to", "claude", "--cwd", project, "--name", name, "--file", "-"], {
    as: LEAD,
    input: name,
  });
  return { ...d, sid: uuid() } as { workerId: string; requestId: string; contract: string; sid: string };
}
const ups = (w: { sid: string }, promptId: string, prompt: string) => ({
  session_id: w.sid,
  hook_event_name: "UserPromptSubmit",
  prompt_id: promptId,
  cwd: project,
  prompt,
});
const stop = (w: { sid: string }, promptId: string, text: string, bg: unknown[] | null = []) => ({
  session_id: w.sid,
  hook_event_name: "Stop",
  prompt_id: promptId,
  cwd: project,
  last_assistant_message: text,
  ...(bg ? { background_tasks: bg } : {}),
});
const phase = (requestId: string) => s.ok(["delegations", requestId], { as: LEAD }).delegations[0];
const kinds = (requestId: string) =>
  s
    .ok(["read", "--correlation", requestId, "--type", "notice"], { as: LEAD })
    .messages.map((m: any) => m.notice.kind);
const SPOOL = { AGENTBUS_FAULT_INJECT: "hook-spool" };

describe("event ordering", () => {
  test("a spooled claim keeps later events of the same session behind it", () => {
    const w = worker("spooled-claim");
    const p1 = uuid();
    s.hook(ups(w, p1, w.contract), SPOOL);
    expect(spooled()).toHaveLength(1);
    // The session is unknown to the store, but its pending claim makes the Stop eligible and ordered.
    s.hook(stop(w, p1, "first final"));
    expect(spooled()).toHaveLength(0);
    expect(kinds(w.requestId)).toEqual(["turn_finished"]);
    expect(phase(w.requestId).phase).toBe("idle");
  });

  test("a delayed claim cannot rebind a newer generation", () => {
    const w = worker("delayed-claim");
    const p1 = uuid();
    s.hook(ups(w, p1, w.contract), SPOOL);
    const [file] = spooled();
    const parked = join(s.dir, "parked.json");
    renameSync(join(spoolDir(), file!), parked);
    const p3 = uuid();
    s.hook(ups(w, p3, w.contract));
    s.hook(stop(w, p3, "p3 final"));
    renameSync(parked, join(spoolDir(), file!));
    s.ok(["event", "drain"]);
    const turns = s.sql<{ native_turn_id: string }>(
      "SELECT native_turn_id FROM turn_bindings WHERE session_id = ? ORDER BY generation",
      w.workerId,
    );
    expect(turns.map((t) => t.native_turn_id)).toEqual([p3]);
    expect(phase(w.requestId).phase).toBe("idle");
  });
});

describe("attribution", () => {
  test("permission requests and failures of an unrelated manual turn are not posted", () => {
    const w = worker("manual-then-perm");
    const p1 = uuid();
    s.hook(ups(w, p1, w.contract));
    s.hook(stop(w, p1, "bound final"));
    const p2 = uuid();
    s.hook(ups(w, p2, "manual follow-up from the user"));
    const perm = {
      session_id: w.sid,
      hook_event_name: "PermissionRequest",
      cwd: project,
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };
    s.hook({ ...perm, prompt_id: p2 });
    s.hook(perm);
    s.hook({
      session_id: w.sid,
      hook_event_name: "StopFailure",
      prompt_id: p2,
      cwd: project,
      error_type: "rate_limit",
    });
    expect(kinds(w.requestId)).toEqual(["turn_finished", "tracking_lost"]);
  });

  test("permission summaries list argument names, never values", () => {
    const w = worker("perm-keys");
    const p1 = uuid();
    s.hook(ups(w, p1, w.contract));
    s.hook({
      session_id: w.sid,
      hook_event_name: "PermissionRequest",
      prompt_id: p1,
      cwd: project,
      tool_name: "Edit",
      tool_input: { file_path: "/secret/path", old_string: "token=abc", new_string: "x" },
    });
    const body = s.ok(["read", "--correlation", w.requestId, "--type", "notice"], { as: LEAD }).messages[0]
      .body;
    expect(body).toBe("Edit (file_path, old_string, new_string)");
  });

  test("a task from an earlier turn of the chain still continues it", () => {
    const w = worker("chain");
    const p1 = uuid();
    s.hook(ups(w, p1, w.contract));
    s.hook(
      stop(w, p1, "two tasks", [
        { id: "taskA", status: "running" },
        { id: "taskB", status: "running" },
      ]),
    );
    const note = (id: string) =>
      `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`;
    const p2 = uuid();
    s.hook(ups(w, p2, note("taskA")));
    s.hook(stop(w, p2, "A done", [{ id: "taskB", status: "running" }]));
    s.hook(ups(w, uuid(), note("taskB")));
    expect(phase(w.requestId).phase).toBe("working");
    expect(kinds(w.requestId)).not.toContain("tracking_lost");
  });

  test("a large wait receipt still proves provenance; timeout re-arms do not ping the parent", () => {
    const w = worker("big-wait");
    const p1 = uuid();
    s.hook(ups(w, p1, w.contract));
    s.ok(["ack", w.requestId], { as: w.workerId });
    const q = s.ok(["reply", w.requestId, "--type", "question", "--file", "-"], {
      as: w.workerId,
      input: "?",
    });
    const waited = s.run(["wait", "--correlation", w.requestId, "--timeout", "200ms"], { as: w.workerId });
    expect(waited.code).toBe(3);
    const tasks = join(s.dir, w.sid, "tasks");
    mkdirSync(tasks, { recursive: true });
    // Pad the receipt to well past the scan windows, as a large batch would.
    const padded = waited.stdout.replace('"messages":[]', `"messages":[],"pad":"${"x".repeat(600_000)}"`);
    writeFileSync(join(tasks, "bigwait.output"), padded);
    s.hook(stop(w, p1, "asked", [{ id: "bigwait", status: "running" }]));
    const p2 = uuid();
    s.hook(
      ups(
        w,
        p2,
        `<task-notification>\n<task-id>bigwait</task-id>\n<output-file>${join(tasks, "bigwait.output")}</output-file>\n<status>completed</status>\n</task-notification>`,
      ),
    );
    expect(phase(w.requestId).phase).toBe("question");
    // The worker re-arms after the timeout and ends the turn: no notice while the question is open.
    s.hook(stop(w, p2, "still waiting", [{ id: "rearm", status: "running" }]));
    expect(kinds(w.requestId)).toEqual([]);
    s.ok(["reply", q.messageId, "--file", "-"], { as: LEAD, input: "answer" });
  });

  test("a Stop without a background task list is unknown, not idle", () => {
    const w = worker("no-bg-list");
    const p1 = uuid();
    s.hook(ups(w, p1, w.contract));
    s.hook(stop(w, p1, "final", null));
    expect(phase(w.requestId).phase).toBe("unknown");
  });
});

describe("capture boundaries and runs", () => {
  test("a prompt merely mentioning the contract tag is not captured without a store", () => {
    const empty = new Store();
    empty.hook({
      session_id: uuid(),
      hook_event_name: "UserPromptSubmit",
      prompt_id: uuid(),
      cwd: empty.dir,
      prompt: 'Docs say blocks start with <agentbus-contract version="1"> and end later.',
    });
    expect(existsSync(empty.stateDir)).toBe(false);
    empty.cleanup();
  });

  test("a resume is refused while the previous run is still active", () => {
    const d = s.ok(["delegate", "--to", "codex", "--file", "-"], { as: LEAD, input: "codex" });
    const ev = (runId: string, ordinal: number, kind: string, extra: Record<string, unknown> = {}) => {
      const f = join(s.dir, `${uuid()}.json`);
      writeFileSync(
        f,
        JSON.stringify({
          schemaVersion: 1,
          eventId: uuid(),
          runId,
          ordinal,
          workerId: d.workerId,
          requestId: d.requestId,
          kind,
          capturedAt: new Date().toISOString(),
          ...extra,
        }),
      );
      return s.run(["event", "ingest", "--provider", "codex", "--source", "runner", "--file", f]);
    };
    const run1 = uuid();
    const thread = uuid();
    expect(ev(run1, 0, "run_started").code).toBe(0);
    expect(ev(run1, 1, "thread_started", { threadId: thread }).code).toBe(0);
    expect(ev(run1, 2, "turn_started").code).toBe(0);
    const second = ev(uuid(), 0, "run_started", { resumeThreadId: thread });
    expect(second.code).toBe(5);
    expect(second.json?.error.code).toBe("run_active");
    expect(ev(run1, 3, "run_finished", { exit: { code: 1, signal: null } }).code).toBe(0);
    expect(kinds(d.requestId)).toEqual(["turn_failed"]);
  });

  test("a missing inventory row after a recorded owner died is tracking loss, not interruption", async () => {
    const w = worker("vanished");
    s.hook(ups(w, uuid(), w.contract));
    const owner = Bun.spawn(["sleep", "60"], { stdout: "ignore" });
    procs.push(owner);
    writeFileSync(
      agentsFile,
      JSON.stringify([{ id: "v1", sessionId: w.sid, kind: "background", pid: owner.pid, status: "busy" }]),
    );
    expect(s.ok(["delegations", w.requestId, "--probe"], { as: LEAD }).delegations[0].probe.evidence).toBe(
      "alive",
    );
    owner.kill();
    await owner.exited;
    writeFileSync(agentsFile, "[]");
    const after = s.ok(["delegations", w.requestId, "--probe"], { as: LEAD }).delegations[0];
    expect(after.probe.evidence).toBe("tracking_lost");
    expect(after.phase).toBe("unknown");
    // A new owner generation forgets the old process: its death cannot interrupt the new owner.
    s.hook({ session_id: w.sid, hook_event_name: "SessionStart", source: "resume", cwd: project });
    writeFileSync(
      agentsFile,
      JSON.stringify([{ id: "v1", sessionId: w.sid, kind: "background", state: "stopped" }]),
    );
    expect(s.ok(["delegations", w.requestId, "--probe"], { as: LEAD }).delegations[0].phase).not.toBe(
      "interrupted",
    );
  });

  test("Ctrl-C closes the wait arm before exiting", async () => {
    s.register("generic", "sigint");
    const proc = s.spawn(["wait", "--timeout", "30s"], { as: "generic:sigint" });
    await sleep(800);
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(130);
    const arms = s.sql<{ end_reason: string | null }>(
      "SELECT end_reason FROM wait_arms WHERE session_id = (SELECT id FROM sessions WHERE external_id = 'sigint')",
    );
    expect(arms.map((a) => a.end_reason)).toEqual(["interrupted"]);
  });
});
