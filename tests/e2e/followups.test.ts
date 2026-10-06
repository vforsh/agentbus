// Parent follow-ups reaching a running Claude worker through the doorbell hook, mail settlement at a
// delegation's end, and the global delegations board.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, Store, type Store as StoreT, uuid } from "../harness.ts";

let s: StoreT;
let project: string;
let leadId: string;
const LEAD = `claude:${uuid()}`;
const OTHER = `claude:${uuid()}`;

beforeAll(() => {
  s = new Store().init();
  project = join(s.dir, "project");
  mkdirSync(project);
  leadId = s.register("claude", LEAD.slice(7), "lead");
  s.register("claude", OTHER.slice(7), "bystander");
});
afterAll(() => s.cleanup());

interface Worker {
  workerId: string;
  requestId: string;
  contract: string;
  claudeSettings: string;
  sid: string;
  prompt: string;
}

/** A delegated Claude worker that has claimed its contract and is mid-turn. */
function runningWorker(name: string): Worker {
  const d = s.ok(["delegate", "--to", "claude", "--cwd", project, "--name", name, "--file", "-"], {
    as: LEAD,
    input: `Task for ${name}`,
  });
  const w = { ...d, sid: uuid(), prompt: uuid() } as Worker;
  expect(s.hook(payload(w, "UserPromptSubmit-probe", { prompt: `Go.\n\n${w.contract}\n` })).stdout).toBe("");
  s.ok(["ack", w.requestId], { as: w.workerId });
  return w;
}

function payload(w: Worker, name: string, extra: Record<string, unknown> = {}) {
  const recorded = fixture(`claude/${name}.json`);
  delete recorded._fixture;
  return { ...recorded, session_id: w.sid, cwd: project, prompt_id: w.prompt, ...extra };
}

const toolCall = (w: Worker) => s.hook(payload(w, "PostToolUse.synthetic"));
const stop = (w: Worker, text: string) =>
  s.hook(payload(w, "Stop-idle", { last_assistant_message: text, background_tasks: [] }));
const send = (to: string, as: string, body: string, summary?: string) =>
  s.ok(["send", to, "--file", "-", ...(summary ? ["--summary", summary] : [])], { as, input: body });
const followup = (w: Worker, body: string, extra: string[] = []) =>
  s.ok(["followup", w.requestId, "--file", "-", ...extra], { as: LEAD, input: body });
const result = (w: Worker, outcome = "success", key?: string) =>
  s.run(
    [
      "reply",
      w.requestId,
      "--type",
      "result",
      "--outcome",
      outcome,
      ...(key ? ["--key", key] : []),
      "--file",
      "-",
    ],
    { as: w.workerId, input: `result: ${outcome}` },
  );
const receipt = (id: string) =>
  s.sql("SELECT acknowledged_at, settled_reason FROM receipts WHERE message_id = ?", id)[0];
const phase = (w: Worker) => s.ok(["delegations", w.requestId], { as: LEAD }).delegations[0].phase;
const notices = (w: Worker) =>
  s.ok(["read", "--correlation", w.requestId, "--type", "notice"], { as: LEAD }).messages;

describe("parent follow-ups", () => {
  test("a parent's message joins the worker's open delegation; anyone else's starts its own", () => {
    const w = runningWorker("joiner");
    expect(send(w.workerId, LEAD, "Port is 8080").correlationId).toBe(w.requestId);
    const stray = send(w.workerId, OTHER, "unrelated");
    expect(stray.correlationId).toBe(stray.messageId);
  });

  test("a tool call announces parent follow-ups once, with exact commands; other mail never rings", () => {
    const w = runningWorker("listener");
    expect(toolCall(w).stdout).toBe("");
    send(w.workerId, OTHER, "not from the parent");
    expect(toolCall(w).stdout).toBe("");

    const f = send(w.workerId, LEAD, "Use the staging watcher.\nDetails follow.", "Staging watcher is up");
    const r = toolCall(w);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(text).toContain(`${f.messageId} (message): Staging watcher is up`);
    expect(text).toContain(
      `${join(s.stateDir, "workers", w.workerId, "agentbus")} read --from ${leadId} --json`,
    );
    expect(text).toContain(`ack ${f.messageId}`);
    // Announced means seen: the next tool call stays quiet, and the worker still reads and acknowledges.
    expect(toolCall(w).stdout).toBe("");
    const mail = s.ok(["read", "--from", leadId], { as: w.workerId }).messages;
    expect(mail.map((m: any) => m.id)).toEqual([f.messageId]);
    expect(mail[0].seenAt).not.toBeNull();
    s.ok(["ack", f.messageId], { as: w.workerId });
    expect(phase(w)).toBe("working");
  });

  test("an unread follow-up blocks Stop: the turn continues and is not observed as finished", () => {
    const w = runningWorker("stopper");
    const f = send(w.workerId, LEAD, "Also cover the empty state", "Scope change");
    const blocked = stop(w, "All done.");
    expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: "block" });
    expect(JSON.parse(blocked.stdout).reason).toContain(f.messageId);
    expect(JSON.parse(blocked.stdout).reason).toContain("before ending your turn");
    expect(notices(w)).toHaveLength(0);
    expect(phase(w)).toBe("working");

    expect(stop(w, "All done, empty state included.").stdout).toBe("");
    expect(notices(w).map((m: any) => m.body)).toEqual(["All done, empty state included."]);
  });

  test("the per-worker settings command prints the doorbell decision", () => {
    const w = runningWorker("via-settings");
    send(w.workerId, LEAD, "ping");
    const settings = JSON.parse(readFileSync(w.claudeSettings, "utf8"));
    const r = Bun.spawnSync(["sh", "-c", settings.hooks.PostToolUse[0].hooks[0].command], {
      env: s.env({ AGENTBUS_STATE_DIR: undefined, AGENTBUS_CONFIG: undefined }),
      stdin: Buffer.from(JSON.stringify(payload(w, "PostToolUse.synthetic"))),
      stdout: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).hookSpecificOutput.additionalContext).toContain("ping");
  });
});

describe("completion gate", () => {
  test("follow-up before result: success waits until the follow-up is acknowledged", () => {
    const w = runningWorker("gated");
    const f = followup(w, "Also handle the empty state", ["--summary", "Scope change"]);
    expect(f).toMatchObject({ requestId: w.requestId, correlationId: w.requestId, to: w.workerId });
    const refused = result(w, "success", "result-gated");
    expect(refused.code).toBe(5);
    expect(refused.json?.error).toMatchObject({
      code: "followups_pending",
      details: { requestId: w.requestId, pending: [f.messageId], unseen: 1 },
    });
    expect(s.ok(["delegations", w.requestId], { as: LEAD }).delegations[0]).toMatchObject({
      state: "open",
      followUps: { pending: 1, unseen: 1 },
    });
    // Seen is not handled: a read-only sweep and the doorbell's claim leave the gate closed.
    expect(s.ok(["read", "--correlation", w.requestId], { as: w.workerId }).messages).toHaveLength(1);
    expect(JSON.parse(toolCall(w).stdout).hookSpecificOutput.additionalContext).toContain(f.messageId);
    expect(result(w, "success", "result-gated").json?.error.details).toMatchObject({ unseen: 0 });
    s.ok(["ack", f.messageId], { as: w.workerId });
    const done = result(w, "success", "result-gated");
    expect(done.code).toBe(0);
    expect(done.json?.data).toMatchObject({ duplicate: false, unhandledFollowUps: [] });
    // The refused attempts consumed no key: the exact retry returns the committed result.
    expect(result(w, "success", "result-gated").json?.data).toMatchObject({
      messageId: done.json?.data.messageId,
      duplicate: true,
    });
  });

  test("answers to questions are follow-ups too", () => {
    const w = runningWorker("asked");
    const q = s.ok(["reply", w.requestId, "--type", "question", "--summary", "Which DB?", "--file", "-"], {
      as: w.workerId,
      input: "Postgres or SQLite?",
    });
    const a = s.ok(["reply", q.messageId, "--file", "-"], { as: LEAD, input: "SQLite" });
    expect(result(w).json?.error).toMatchObject({
      code: "followups_pending",
      details: { pending: [a.messageId] },
    });
    s.ok(["ack", a.messageId], { as: w.workerId });
    expect(result(w).code).toBe(0);
  });

  test("result before follow-up: the follow-up, a late answer and a late reply are refused, not filed", () => {
    const w = runningWorker("late");
    const q = s.ok(["reply", w.requestId, "--type", "question", "--summary", "Ok?", "--file", "-"], {
      as: w.workerId,
      input: "proceeding unless told otherwise",
    });
    expect(result(w, "success", "result-late").code).toBe(0);
    const late = s.run(["followup", w.requestId, "--file", "-"], { as: LEAD, input: "wait, one more thing" });
    expect(late.code).toBe(5);
    expect(late.json?.error).toMatchObject({
      code: "delegation_closed",
      details: { requestId: w.requestId, state: "done", outcome: "success" },
    });
    expect(s.run(["followup", "late", "--dry-run", "--file", "-"], { as: LEAD, input: "x" }).code).toBe(5);
    const answer = s.run(["reply", q.messageId, "--file", "-"], { as: LEAD, input: "stop" });
    expect(answer.json?.error.code).toBe("delegation_closed");
    // Generic messaging still works, but no longer pretends to be a follow-up.
    const plain = s.run(["send", w.workerId, "--file", "-"], { as: LEAD, input: "fyi" });
    expect(plain.code).toBe(0);
    expect(plain.json?.data).toMatchObject({ joined: null });
    expect(plain.json?.data.correlationId).not.toBe(w.requestId);
    expect(plain.stderr).toContain("not a follow-up");
    expect(s.sql("SELECT count(*) AS n FROM messages WHERE correlation_id = ?", w.requestId)[0].n).toBe(3);
  });

  test("a generic send that joins an open delegation is held to the same gate", () => {
    const w = runningWorker("joined");
    const f = send(w.workerId, LEAD, "port is 8080");
    expect(f.joined).toBe(w.requestId);
    expect(result(w).json?.error.code).toBe("followups_pending");
  });

  test("keyed follow-ups return their original receipt, even after the delegation ended", () => {
    const w = runningWorker("keyed");
    const first = followup(w, "use v2", ["--key", "fu-1"]);
    expect(followup(w, "use v2", ["--key", "fu-1"])).toMatchObject({
      messageId: first.messageId,
      duplicate: true,
    });
    const changed = s.run(["followup", w.requestId, "--key", "fu-1", "--file", "-"], {
      as: LEAD,
      input: "use v3",
    });
    expect(changed.json?.error.code).toBe("idempotency_conflict");
    s.ok(["ack", first.messageId], { as: w.workerId });
    expect(result(w).code).toBe(0);
    expect(followup(w, "use v2", ["--key", "fu-1"])).toMatchObject({
      messageId: first.messageId,
      duplicate: true,
    });
    expect(
      s.run(["followup", w.requestId, "--key", "fu-2", "--file", "-"], { as: LEAD, input: "x" }).code,
    ).toBe(5);
  });

  test("only the parent can follow up; names resolve among its own delegations", () => {
    const w = runningWorker("named");
    expect(s.run(["followup", w.requestId, "--file", "-"], { as: OTHER, input: "x" }).json?.error.code).toBe(
      "not_parent",
    );
    expect(s.run(["followup", "named", "--file", "-"], { as: OTHER, input: "x" }).code).toBe(4);
    expect(followup({ ...w, requestId: "named" }, "by name").requestId).toBe(w.requestId);
  });

  test("concurrent follow-up and result: exactly one wins, the other is refused visibly", async () => {
    for (let i = 0; i < 6; i++) {
      const w = runningWorker(`race-${i}`);
      const [f, r] = await Promise.all([
        s.runAsync(["followup", w.requestId, "--file", "-"], { as: LEAD, input: `race ${i}` }),
        s.runAsync(["reply", w.requestId, "--type", "result", "--outcome", "success", "--file", "-"], {
          as: w.workerId,
          input: "done",
        }),
      ]);
      expect([f.code, r.code].sort()).toEqual([0, 5]);
      if (f.code === 0) {
        expect(r.json?.error.code).toBe("followups_pending");
        expect(receipt(f.json?.data.messageId)).toEqual({ acknowledged_at: null, settled_reason: null });
      } else {
        expect(f.json?.error.code).toBe("delegation_closed");
      }
      const leftovers = s.sql(
        "SELECT count(*) AS n FROM receipts r JOIN messages m ON m.id = r.message_id WHERE m.correlation_id = ? AND r.settled_reason IS NOT NULL AND m.type = 'message'",
        w.requestId,
      );
      expect(leftovers[0].n).toBe(0);
      s.ok(["close", w.requestId], { as: LEAD });
    }
  });

  test("the parent's close is never gated and settles pending follow-ups", () => {
    const w = runningWorker("cancelled");
    const f = followup(w, "never mind");
    const closed = s.ok(["close", w.requestId], { as: LEAD });
    expect(closed).toMatchObject({ state: "closed", changed: true });
    expect(receipt(f.messageId)).toMatchObject({ settled_reason: "delegation_closed" });
    expect(result(w, "failed").json?.error.code).toBe("delegation_closed");
  });
});

describe("settlement", () => {
  test("a non-success result settles unacknowledged follow-ups and reports them as unhandled", () => {
    const w = runningWorker("finisher");
    const late = followup(w, "one more thing");
    const r = s.run(["reply", w.requestId, "--type", "result", "--outcome", "blocked", "--file", "-"], {
      as: w.workerId,
      input: "cannot continue",
    });
    expect(r.code).toBe(0);
    expect(r.json?.data.unhandledFollowUps).toEqual([late.messageId]);
    expect(r.stderr).toContain("never acknowledged");
    expect(receipt(late.messageId)).toMatchObject({ settled_reason: "delegation_done" });
    expect(receipt(late.messageId).acknowledged_at).not.toBeNull();
    expect(receipt(r.json?.data.messageId)).toEqual({ acknowledged_at: null, settled_reason: null });
    expect(s.ok(["read"], { as: w.workerId }).messages).toHaveLength(0);
    const view = s.ok(["delegations", w.requestId], { as: LEAD }).delegations[0];
    expect(view.followUps).toMatchObject({ total: 1, unhandled: 1, unhandledIds: [late.messageId] });
  });

  test("a parent's close settles the whole correlation, visible in history", () => {
    const w = runningWorker("abandoned");
    const q = s.ok(["reply", w.requestId, "--type", "question", "--summary", "Which color?", "--file", "-"], {
      as: w.workerId,
      input: "red or blue",
    });
    s.ok(["close", w.requestId], { as: LEAD });
    expect(s.ok(["read", "--correlation", w.requestId], { as: LEAD }).messages).toHaveLength(0);
    const history = s.ok(["read", "--all", "--correlation", w.requestId], { as: LEAD }).messages;
    expect(history.find((m: any) => m.id === q.messageId).settledReason).toBe("delegation_closed");
  });
});

describe("global board", () => {
  test("delegations --global needs no caller and names each parent", () => {
    const noCaller = { CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined };
    expect(s.run(["delegations"], { env: noCaller }).code).toBe(2);
    const board = s.ok(["delegations", "--global"], { env: noCaller }).delegations;
    expect(board.length).toBeGreaterThan(0);
    expect(board.every((d: any) => d.parent.id === leadId && d.parent.name === "lead")).toBe(true);
    const one = s.ok(["delegations", "--global", "listener"], { env: noCaller }).delegations;
    expect(one.map((d: any) => d.name)).toEqual(["listener"]);
  });
});
