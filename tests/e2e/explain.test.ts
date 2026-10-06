// `agentbus explain`: chronological evidence plus next steps for each delegation situation, driven by
// recorded hook payloads and real wait processes. Explaining never changes receipts, delegations or the spool.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, Store, sleep, uuid } from "../harness.ts";

let s: Store;
let project: string;
const LEAD = `claude:${uuid()}`;
const SECRET = "body-only-secret-7c1f";

beforeAll(() => {
  s = new Store().init();
  project = join(s.dir, "project");
  mkdirSync(project);
  s.register("claude", LEAD.slice(7), "lead");
});
afterAll(() => s.cleanup());

interface Worker {
  workerId: string;
  requestId: string;
  contract: string;
  sid: string;
  prompt: string;
}

function delegate(name: string, to = "claude"): Worker {
  const d = s.ok(["delegate", "--to", to, "--cwd", project, "--name", name, "--file", "-"], {
    as: LEAD,
    input: `Task for ${name}. ${SECRET}`,
  });
  return { ...d, sid: uuid(), prompt: uuid() };
}

const hook = (w: Worker, name: string, extra: Record<string, unknown> = {}, env = {}) => {
  const recorded = fixture(`claude/${name}.json`);
  delete recorded._fixture;
  return s.hook({ ...recorded, session_id: w.sid, cwd: project, prompt_id: w.prompt, ...extra }, env);
};
function running(name: string): Worker {
  const w = delegate(name);
  hook(w, "UserPromptSubmit-probe", { prompt: `Go.\n\n${w.contract}\n` });
  s.ok(["ack", w.requestId], { as: w.workerId });
  return w;
}
const explain = (target: string, extra: string[] = []) => s.ok(["explain", target, ...extra], { as: LEAD });
const kinds = (x: any) => x.actions.map((a: any) => a.kind);
const ask = (w: Worker) =>
  s.ok(["reply", w.requestId, "--type", "question", "--summary", "Which DB?", "--file", "-"], {
    as: w.workerId,
    input: `Postgres or SQLite? ${SECRET}`,
  });

/** Everything explain reads must be unchanged by it. */
const snapshot = () =>
  JSON.stringify([
    s.sql("SELECT message_id, seen_at, acknowledged_at, settled_reason FROM receipts ORDER BY message_id"),
    s.sql("SELECT request_id, state, outcome FROM delegations ORDER BY request_id"),
    s.sql("SELECT id, ended_at FROM wait_arms ORDER BY id"),
    s.sql("SELECT count(*) AS n FROM observations"),
    readdirSync(join(s.stateDir, "spool")).sort(),
  ]);

describe("explain", () => {
  test("pending launch: reconcile, never relaunch; by unambiguous name; structured output", () => {
    const w = delegate("unlaunched");
    const x = explain("unlaunched");
    expect(Object.keys(x).sort()).toEqual(["actions", "delegation", "diagnosis", "probe", "timeline"]);
    expect(x.delegation.requestId).toBe(w.requestId);
    expect(x.diagnosis).toMatchObject({ phase: "pending", stalled: true, worker: { bound: false } });
    expect(kinds(x)).toContain("reconcile_launch");
    expect(x.actions.find((a: any) => a.kind === "reconcile_launch").commands.join(" ")).toContain(
      `session bind ${w.workerId}`,
    );
    expect(x.timeline).toMatchObject({ total: 2, shown: 2, omitted: 0 });
    expect(x.timeline.events.map((e: any) => e.kind)).toEqual(["delegation_opened", "request"]);
    for (const e of x.timeline.events)
      expect(Object.keys(e)).toEqual(
        expect.arrayContaining(["at", "kind", "source", "actor", "text", "refs"]),
      );
  });

  test("working, and an unanswered question with the worker's wait state", () => {
    const w = running("busy");
    const working = explain(w.requestId);
    expect(working.diagnosis).toMatchObject({ phase: "working", stalled: false });
    expect(kinds(working)).toContain("wait");
    expect(working.timeline.events.map((e: any) => e.text)).toContain("turn started (contract) [gen 1]");

    const q = ask(w);
    const x = explain(w.requestId);
    expect(x.diagnosis).toMatchObject({
      phase: "question",
      stalled: true,
      pendingQuestion: { id: q.messageId },
    });
    expect(x.diagnosis.parentInbox).toMatchObject({ pending: 1, unseen: 1 });
    expect(kinds(x).slice(0, 2)).toEqual(["recover_mail", "answer_question"]);
    expect(x.diagnosis.worker.wait).toMatchObject({ readiness: "not_armed" });
  });

  test("answered but not resumed: nudge unless the worker's own wait will deliver the answer", async () => {
    const w = running("answered");
    const q = ask(w);
    hook(w, "Stop-idle", { last_assistant_message: "Asked; waiting.", background_tasks: [] });
    s.ok(["reply", q.messageId, "--file", "-"], { as: LEAD, input: "SQLite" });
    const x = explain(w.requestId);
    expect(x.diagnosis).toMatchObject({ phase: "pending", stalled: true });
    expect(x.diagnosis.summary).toContain("no new worker turn has started");
    expect(kinds(x)).toContain("nudge_worker");
    expect(x.diagnosis.followUps).toMatchObject({ pending: 1 });
    expect(x.timeline.events.find((e: any) => e.kind === "message").text).toStartWith("answer:");

    const wait = s.spawn(
      ["wait", "--replace", "--correlation", w.requestId, "--type", "notice", "--timeout", "30s"],
      {
        as: w.workerId,
      },
    );
    await sleep(500);
    // A --type filtered wait would not deliver the answer: still a nudge.
    expect(kinds(explain(w.requestId))).toContain("nudge_worker");
    wait.kill("SIGINT");
    await wait.exited;
  });

  test("permission, interruption and tracking loss each point at their own next step", () => {
    const p = running("prompting");
    hook(p, "PermissionRequest.synthetic");
    const perm = explain(p.requestId);
    expect(perm.diagnosis.phase).toBe("permission");
    expect(kinds(perm)).toContain("inspect_permission");
    expect(perm.diagnosis.uncertain.join(" ")).toContain("last-known");

    const i = running("crashed");
    hook(i, "SessionEnd", { reason: "other" });
    const crashed = explain(i.requestId);
    expect(crashed.diagnosis.phase).toBe("interrupted");
    expect(kinds(crashed)).toContain("decide_retry_or_close");
    expect(crashed.timeline.events.some((e: any) => e.kind === "turn_interrupted")).toBe(true);

    const u = running("hijacked");
    hook(u, "UserPromptSubmit-probe", { prompt: "an unrelated manual prompt", prompt_id: uuid() });
    const lost = explain(u.requestId);
    expect(lost.diagnosis.phase).toBe("unknown");
    expect(kinds(lost)).toContain("reconcile_ownership");
    expect(lost.diagnosis.turn.current).toBe(false);
    expect(lost.timeline.events.map((e: any) => e.kind)).toContain("tracking_lost");
  });

  test("parent watcher: missing or dead is a re-arm action; a live one is not", async () => {
    const w = running("watched");
    const before = explain(w.requestId);
    expect(kinds(before)).toContain("rearm_watcher");
    // Correlated, so the lead's unrelated unseen mail from earlier checks does not end it at once.
    const proc = s.spawn(["wait", "--replace", "--correlation", w.requestId, "--timeout", "30s"], {
      as: LEAD,
    });
    for (let i = 0; i < 100 && explain(w.requestId).diagnosis.returnPath.readiness !== "armed"; i++)
      await sleep(50);
    const live = explain(w.requestId);
    expect(live.diagnosis.returnPath.readiness).toBe("armed");
    expect(kinds(live)).not.toContain("rearm_watcher");
    expect(live.timeline.events.map((e: any) => e.kind)).toContain("wait_armed");
    proc.kill("SIGKILL");
    await proc.exited;
    const dead = explain(w.requestId);
    expect(dead.diagnosis.returnPath).toMatchObject({ readiness: "not_armed", watcher: { state: "dead" } });
    expect(dead.actions.find((a: any) => a.kind === "rearm_watcher").commands).toEqual([
      "agentbus wait --replace --timeout 30m --probe 60s --json",
    ]);
  });

  test("heartbeat parent: set up when never recorded, refresh when stale", () => {
    const codex = `codex:${uuid()}`;
    s.register("codex", codex.slice(6), "planner");
    const w = s.ok(["delegate", "--to", "claude", "--cwd", project, "--name", "beat", "--file", "-"], {
      as: codex,
      input: "task",
    });
    const setup = s
      .ok(["explain", w.requestId], { as: codex })
      .actions.find((a: any) => a.kind === "refresh_heartbeat");
    expect(setup.commands[0]).toContain("--binding-file -");
    s.ok(["session", "update", codex, "--binding-file", "-"], {
      input: JSON.stringify({
        strategy: "heartbeat",
        status: "ready",
        checkedAt: "2026-01-01T00:00:00.000Z",
      }),
    });
    const stale = s.ok(["explain", w.requestId], { as: codex });
    expect(stale.diagnosis.returnPath.readiness).toBe("stale");
    expect(stale.actions.find((a: any) => a.kind === "refresh_heartbeat").commands).toEqual([
      `agentbus session update ${codex} --refresh`,
    ]);
    s.ok(["session", "update", codex, "--refresh"]);
    expect(kinds(s.ok(["explain", w.requestId], { as: codex }))).not.toContain("refresh_heartbeat");
  });

  test("queued hook events are reported, not drained", () => {
    const w = running("queued");
    hook(w, "Stop-idle", { last_assistant_message: "spooled" }, { AGENTBUS_FAULT_INJECT: "hook-spool" });
    const x = explain(w.requestId);
    expect(x.diagnosis.spool).toMatchObject({ backlog: 1, forWorker: true });
    expect(kinds(x)[0]).toBe("drain_events");
    s.ok(["event", "drain"]);
  });

  test("completed work: result, unhandled follow-ups and handoff evidence", () => {
    const w = running("finished");
    const f = s.ok(["followup", w.requestId, "--summary", "Also docs", "--file", "-"], {
      as: LEAD,
      input: "x",
    });
    s.ok(
      [
        "reply",
        w.requestId,
        "--type",
        "result",
        "--outcome",
        "failed",
        "--summary",
        "Gave up",
        "--file",
        "-",
      ],
      {
        as: w.workerId,
        input: "could not",
      },
    );
    hook(w, "Stop-idle", { last_assistant_message: "Published the result.", background_tasks: [] });
    const x = explain(w.requestId);
    expect(x.diagnosis).toMatchObject({ phase: "done", outcome: "failed", stalled: false });
    expect(x.diagnosis.followUps).toMatchObject({ unhandled: 1, unhandledIds: [f.messageId] });
    expect(kinds(x)).toEqual(expect.arrayContaining(["recover_mail", "review_unhandled"]));
    expect(x.actions.find((a: any) => a.kind === "review_unhandled").ids).toEqual([f.messageId]);
    expect(kinds(x)).not.toContain("rearm_watcher");
    const kindsInOrder = x.timeline.events.map((e: any) => e.kind);
    expect(kindsInOrder.indexOf("delegation_done")).toBeGreaterThan(kindsInOrder.indexOf("request"));
    expect(kindsInOrder).toContain("turn_finished");
    const times = x.timeline.events.map((e: any) => e.at);
    expect([...times].sort()).toEqual(times);
  });

  test("bounded, body-free and read-only; truncation is explicit; plain and human output render", () => {
    const w = running("long");
    for (let i = 0; i < 6; i++)
      s.ok(["followup", w.requestId, "--file", "-"], { as: LEAD, input: `${SECRET} ${i}` });
    const before = snapshot();
    const full = s.run(["explain", w.requestId], { as: LEAD });
    const page = explain(w.requestId, ["--limit", "3"]);
    const plain = s.run(["explain", w.requestId, "--limit", "3"], { as: LEAD, json: false });
    s.run(["explain", w.requestId, "--plain"], { as: LEAD, json: false });
    expect(snapshot()).toBe(before);
    expect(full.stdout).not.toContain(SECRET);
    expect(plain.stdout).not.toContain(SECRET);
    expect(page.timeline).toMatchObject({ shown: 3, limit: 3 });
    expect(page.timeline.omitted).toBe(page.timeline.total - 3);
    expect(page.timeline.events.at(-1).text).toStartWith("follow-up:");
    expect(plain.stdout).toContain("Timeline (");
    expect(plain.stdout).toContain("older omitted");
    expect(plain.stdout).toMatch(/Next\n {2}1\. /);
    expect(s.run(["explain", w.requestId, "--limit", "0"], { as: LEAD }).code).toBe(2);
  });

  test("caller scoping: another session cannot explain this parent's delegation; --global can", () => {
    const w = delegate("scoped");
    const other = `claude:${uuid()}`;
    s.register("claude", other.slice(7), "other");
    expect(s.run(["explain", w.requestId], { as: other }).json?.error.code).toBe("not_parent");
    expect(s.run(["explain", "scoped"], { as: other }).code).toBe(4);
    const g = s.ok(["explain", "--global", "scoped"], { env: { CLAUDE_CODE_SESSION_ID: undefined } });
    expect(g.delegation.requestId).toBe(w.requestId);
    expect(s.run(["explain", uuid()], { as: LEAD }).code).toBe(4);
  });

  test("--probe follows probe semantics: a failed probe is uncertainty, not death", () => {
    const w = running("probed");
    const x = explain(w.requestId, ["--probe"]);
    expect(x.probe).toMatchObject({ requestId: w.requestId, evidence: "probe_failed" });
    expect(x.diagnosis.phase).toBe("unknown");
    expect(x.diagnosis.uncertain.join(" ")).toContain("probe:");
    expect(kinds(x)).toContain("probe");
  });
});
