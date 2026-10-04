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
    expect(text).toContain(`--as ${w.workerId} read --from ${leadId} --json`);
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

describe("settlement", () => {
  const receipt = (id: string) =>
    s.sql("SELECT acknowledged_at, settled_reason FROM receipts WHERE message_id = ?", id)[0];

  test("a result settles the worker's unread mail; the parent still acknowledges the result", () => {
    const w = runningWorker("finisher");
    const late = send(w.workerId, LEAD, "one more thing");
    const result = s.ok(
      ["reply", w.requestId, "--type", "result", "--outcome", "success", "--summary", "Done", "--file", "-"],
      { as: w.workerId, input: "done" },
    );
    expect(receipt(late.messageId)).toMatchObject({ settled_reason: "delegation_done" });
    expect(receipt(late.messageId).acknowledged_at).not.toBeNull();
    expect(receipt(result.messageId)).toEqual({ acknowledged_at: null, settled_reason: null });
    expect(s.ok(["read"], { as: w.workerId }).messages).toHaveLength(0);
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
