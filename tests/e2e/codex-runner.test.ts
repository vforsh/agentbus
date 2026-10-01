// Codex worker lifecycle driven by runner events through the public CLI, plus liveness probes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, sleep, uuid } from "../harness.ts";

let s: Store;
let fakeClaude: string;
let agentsFile: string;
const LEAD_ID = uuid();
const LEAD = `claude:${LEAD_ID}`;
const procs: ReturnType<typeof Bun.spawn>[] = [];

beforeAll(() => {
  const dir = new Store().dir;
  fakeClaude = join(dir, "fake-claude");
  agentsFile = join(dir, "agents.json");
  writeFileSync(fakeClaude, `#!/bin/sh\n[ -f "${agentsFile}.fail" ] && exit 1\ncat "${agentsFile}"\n`);
  chmodSync(fakeClaude, 0o755);
  writeFileSync(agentsFile, "[]");
  s = new Store({ claudeBin: fakeClaude }).init();
  s.register("claude", LEAD_ID, "lead");
});
afterAll(() => {
  for (const p of procs) p.kill();
  s.cleanup();
});

/** A real process plus its start identity, as the runner records it. */
function liveProcess() {
  const p = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
  procs.push(p);
  const start = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(p.pid)], {
    env: { ...process.env, LC_ALL: "C" },
  })
    .stdout.toString()
    .trim();
  return { proc: p, identity: { pid: p.pid, start } };
}

interface Run {
  workerId: string;
  requestId: string;
  runId: string;
  ordinal: number;
}

function delegateCodex(name: string) {
  const d = s.ok(["delegate", "--to", "codex", "--name", name, "--file", "-"], {
    as: LEAD,
    input: `Codex task ${name}`,
  });
  return { workerId: d.workerId as string, requestId: d.requestId as string, contract: d.contract as string };
}

function emit(run: Run, kind: string, extra: Record<string, unknown> = {}) {
  const ev = {
    schemaVersion: 1,
    eventId: uuid(),
    runId: run.runId,
    ordinal: run.ordinal++,
    workerId: run.workerId,
    requestId: run.requestId,
    kind,
    capturedAt: new Date().toISOString(),
    ...extra,
  };
  const file = join(s.dir, `event-${ev.eventId}.json`);
  writeFileSync(file, JSON.stringify(ev));
  return {
    file,
    result: s.run(["event", "ingest", "--provider", "codex", "--source", "runner", "--file", file]),
  };
}

function startRun(
  d: { workerId: string; requestId: string },
  threadId: string,
  opts: { resume?: string; runner?: unknown; child?: unknown } = {},
) {
  const run: Run = { workerId: d.workerId, requestId: d.requestId, runId: uuid(), ordinal: 0 };
  expect(
    emit(run, "run_started", { resumeThreadId: opts.resume ?? null, runner: opts.runner, runDir: s.dir })
      .result.code,
  ).toBe(0);
  if (opts.child) expect(emit(run, "child_started", { child: opts.child }).result.code).toBe(0);
  const started = emit(run, "thread_started", {
    threadId,
    ...(opts.resume ? { resumeThreadId: opts.resume } : {}),
  });
  expect(started.result.code).toBe(0);
  expect(emit(run, "turn_started").result.code).toBe(0);
  return run;
}

const finishOk = (run: Run, text: string) =>
  emit(run, "run_finished", {
    exit: { code: 0, signal: null },
    turnCompleted: true,
    finalMessage: text,
    finalMessageFresh: true,
  });
const phase = (requestId: string) => s.ok(["delegations", requestId], { as: LEAD }).delegations[0];
const notices = (requestId: string) =>
  s
    .ok(["read", "--correlation", requestId, "--type", "notice"], { as: LEAD })
    .messages.map((m: any) => ({ kind: m.notice.kind, body: m.body }));

describe("runner events", () => {
  test("the recorded exec stream maps to a bound thread and a final-message notice", () => {
    const stream = readFileSync(join(import.meta.dir, "../fixtures/codex/exec-success.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const threadId = stream.find((e) => e.type === "thread.started").thread_id;
    const final = stream.filter((e) => e.type === "item.completed" && e.item.type === "agent_message").pop()
      .item.text;
    const completed = stream.some((e) => e.type === "turn.completed");

    const d = delegateCodex("exec-success");
    const run = startRun(d, threadId);
    expect(s.ok(["session", "show", d.workerId]).session.externalId).toBe(threadId);
    expect(phase(d.requestId).phase).toBe("working");
    const fin = emit(run, "run_finished", {
      exit: { code: 0, signal: null },
      turnCompleted: completed,
      finalMessage: final,
      finalMessageFresh: true,
    });
    expect(fin.result.json?.data.classification).toBe("turn_finished");
    expect(notices(d.requestId)).toEqual([{ kind: "turn_finished", body: final }]);
    expect(phase(d.requestId).phase).toBe("idle");
    // Replaying the identical event file ingests once.
    const replay = s.ok(["event", "ingest", "--provider", "codex", "--source", "runner", "--file", fin.file]);
    expect(replay.status).toBe("duplicate");
    expect(notices(d.requestId)).toHaveLength(1);
  });

  test("failures, signals and missing completion evidence are never results", () => {
    const cases: [string, Record<string, unknown>, string][] = [
      [
        "nonzero",
        { exit: { code: 1, signal: null }, turnCompleted: false, finalMessage: null },
        "turn_failed",
      ],
      ["signal", { exit: { code: null, signal: "SIGTERM" } }, "turn_interrupted"],
      [
        "no-completion",
        {
          exit: { code: 0, signal: null },
          turnCompleted: false,
          finalMessage: "partial",
          finalMessageFresh: true,
        },
        "turn_failed",
      ],
      [
        "stale-final",
        {
          exit: { code: 0, signal: null },
          turnCompleted: true,
          finalMessage: "old",
          finalMessageFresh: false,
        },
        "turn_failed",
      ],
      ["provider-error", { exit: { code: 1, signal: null }, error: "stream disconnected" }, "turn_failed"],
    ];
    for (const [name, fields, kind] of cases) {
      const d = delegateCodex(name);
      const run = startRun(d, uuid());
      expect(emit(run, "run_finished", fields).result.json?.data.classification).toBe(kind);
      expect(notices(d.requestId).map((n: { kind: string }) => n.kind)).toEqual([kind]);
      expect(phase(d.requestId)).toMatchObject({ phase: "interrupted", outcome: null });
    }
  });

  test("a question in the run suppresses the finish notice; the resumed run keeps the thread ID", () => {
    const d = delegateCodex("asker");
    const threadId = uuid();
    const run = startRun(d, threadId);
    // The runner sets AGENTBUS_SESSION_ID; a leaked parent CLAUDE_CODE_SESSION_ID does not win.
    const who = s.ok(["whoami"], {
      env: { AGENTBUS_SESSION_ID: d.workerId, CLAUDE_CODE_SESSION_ID: LEAD_ID },
    });
    expect(who).toMatchObject({ source: "env", registered: true });
    expect(who.session.id).toBe(d.workerId);
    s.ok(["ack", d.requestId], { env: { AGENTBUS_SESSION_ID: d.workerId } });
    const q = s.ok(
      ["reply", d.requestId, "--type", "question", "--summary", "Which config wins?", "--file", "-"],
      {
        env: { AGENTBUS_SESSION_ID: d.workerId },
        input: "config.json or config.local.json?",
      },
    );
    expect(q.attribution).toBe("turn");
    finishOk(run, "Asked the parent which config wins.");
    expect(notices(d.requestId)).toHaveLength(0);
    expect(phase(d.requestId).phase).toBe("question");

    s.ok(["reply", q.messageId, "--file", "-"], { as: LEAD, input: "config.local.json" });
    expect(phase(d.requestId).phase).toBe("pending");
    // A resume naming another thread, or reporting a different thread, is a conflict.
    const wrong: Run = { ...d, runId: uuid(), ordinal: 0 };
    expect(emit(wrong, "run_started", { resumeThreadId: uuid() }).result.code).toBe(5);
    const resumed = { ...d, runId: uuid(), ordinal: 0 };
    expect(emit(resumed, "run_started", { resumeThreadId: threadId }).result.code).toBe(0);
    expect(emit(resumed, "thread_started", { threadId: uuid(), resumeThreadId: threadId }).result.code).toBe(
      5,
    );
    expect(emit(resumed, "thread_started", { threadId, resumeThreadId: threadId }).result.code).toBe(0);
    emit(resumed, "turn_started");
    expect(phase(d.requestId).phase).toBe("working");
    s.ok(
      [
        "reply",
        d.requestId,
        "--type",
        "result",
        "--outcome",
        "success",
        "--summary",
        "local wins",
        "--file",
        "-",
      ],
      {
        env: { AGENTBUS_SESSION_ID: d.workerId },
        input: "Used config.local.json",
      },
    );
    finishOk(resumed, "Done.");
    expect(notices(d.requestId)).toHaveLength(0);
    expect(phase(d.requestId)).toMatchObject({ phase: "done", outcome: "success" });
    // A closed delegation accepts no new runs.
    expect(
      emit({ ...d, runId: uuid(), ordinal: 0 }, "run_started", { resumeThreadId: threadId }).result.code,
    ).toBe(5);
  });

  test("events for an unknown run or the wrong worker are rejected", () => {
    const d = delegateCodex("strict");
    expect(emit({ ...d, runId: uuid(), ordinal: 0 }, "turn_started").result.code).toBe(5);
    const other = delegateCodex("other");
    expect(
      emit({ workerId: other.workerId, requestId: d.requestId, runId: uuid(), ordinal: 0 }, "run_started")
        .result.code,
    ).toBe(5);
    const bad = join(s.dir, "bad-event.json");
    writeFileSync(bad, JSON.stringify({ schemaVersion: 1, kind: "run_started" }));
    expect(s.run(["event", "ingest", "--provider", "codex", "--source", "runner", "--file", bad]).code).toBe(
      2,
    );
  });
});

describe("probes", () => {
  test("a dead runner with a live child is tracking loss; both dead is an interruption", async () => {
    const runner = liveProcess();
    const child = liveProcess();
    const d = delegateCodex("probed");
    startRun(d, uuid(), { runner: runner.identity, child: child.identity });
    expect(s.ok(["delegations", d.requestId, "--probe"], { as: LEAD }).delegations[0].probe.evidence).toBe(
      "alive",
    );

    runner.proc.kill();
    await runner.proc.exited;
    const lost = s.ok(["delegations", d.requestId, "--probe"], { as: LEAD }).delegations[0];
    expect(lost).toMatchObject({ phase: "unknown", tracking: "lost" });
    // Probe notices are deduplicated per evidence transition.
    s.ok(["delegations", d.requestId, "--probe"], { as: LEAD });
    expect(notices(d.requestId).map((n: { kind: string }) => n.kind)).toEqual(["tracking_lost"]);

    child.proc.kill();
    await child.proc.exited;
    const dead = s.ok(["delegations", d.requestId, "--probe"], { as: LEAD }).delegations[0];
    expect(dead.phase).toBe("interrupted");
    expect(notices(d.requestId).map((n: { kind: string }) => n.kind)).toEqual([
      "tracking_lost",
      "turn_interrupted",
    ]);
  });

  test("Claude: a failed or missing inventory is tracking loss; a verified dead owner is an interruption", async () => {
    const owner = liveProcess();
    const project = join(s.dir, "claude-project");
    mkdirSync(project, { recursive: true });
    const d = s.ok(["delegate", "--to", "claude", "--cwd", project, "--name", "bg-claude", "--file", "-"], {
      as: LEAD,
      input: "claude task",
    });
    const sid = uuid();
    s.hook({
      session_id: sid,
      hook_event_name: "UserPromptSubmit",
      prompt_id: uuid(),
      cwd: project,
      prompt: d.contract,
    });
    const row = {
      id: sid.slice(0, 8),
      sessionId: sid,
      kind: "background",
      state: "working",
      status: "busy",
      pid: owner.identity.pid,
      cwd: project,
      startedAt: Date.now(),
    };
    writeFileSync(agentsFile, JSON.stringify([row, { id: "zzz", kind: "background" }]));
    const alive = s.ok(["delegations", d.requestId, "--probe"], { as: LEAD }).delegations[0];
    expect(alive.probe).toMatchObject({ evidence: "alive", owner: "background", activity: "running" });

    writeFileSync(`${agentsFile}.fail`, "");
    const failed = s.ok(["delegations", d.requestId, "--probe"], { as: LEAD }).delegations[0];
    expect(failed).toMatchObject({ phase: "unknown" });
    expect(failed.probe.evidence).toBe("probe_failed");
    Bun.spawnSync(["rm", `${agentsFile}.fail`]);
    expect(s.ok(["delegations", d.requestId, "--probe"], { as: LEAD }).delegations[0].phase).toBe("working");

    owner.proc.kill();
    await owner.proc.exited;
    writeFileSync(
      agentsFile,
      JSON.stringify([{ ...row, pid: undefined, state: "stopped", status: undefined }]),
    );
    const earlier = s.ok(["read", "--correlation", d.requestId], { as: LEAD }).messages.map((m: any) => m.id);
    s.ok(["ack", ...earlier], { as: LEAD });
    // An armed wait with --probe reports the confirmed death.
    const waited = s.run(
      ["wait", "--probe", "10s", "--timeout", "3s", "--type", "notice", "--correlation", d.requestId],
      { as: LEAD },
    );
    expect(waited.code).toBe(0);
    const kinds = waited.json?.data.messages.map((m: any) => m.notice.kind);
    expect(kinds).toContain("turn_interrupted");
    expect(phase(d.requestId).phase).toBe("interrupted");
    await sleep(10);
  });
});
