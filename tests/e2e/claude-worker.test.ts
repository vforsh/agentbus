// Claude worker lifecycle driven by recorded hook payloads through the silent hook entry point.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, Store, type Store as StoreT, sleep, uuid } from "../harness.ts";

let s: StoreT;
let project: string;
const LEAD_ID = uuid();
const LEAD = `claude:${LEAD_ID}`;

beforeAll(() => {
  s = new Store().init();
  project = join(s.dir, "project");
  mkdirSync(project);
  s.register("claude", LEAD_ID, "lead");
});
afterAll(() => s.cleanup());

interface Worker {
  workerId: string;
  requestId: string;
  contract: string;
  sid: string;
}

function delegateClaude(name: string): Worker {
  const d = s.ok(["delegate", "--to", "claude", "--cwd", project, "--name", name, "--file", "-"], {
    as: LEAD,
    input: `Task for ${name}`,
  });
  expect(d.returnPath).toBe("background_wait");
  return { workerId: d.workerId, requestId: d.requestId, contract: d.contract, sid: uuid() };
}

/** Recorded payload shapes with this worker's identity substituted. */
const base = (w: Worker, name: string, extra: Record<string, unknown> = {}) => {
  const recorded = fixture(`claude/${name}.json`);
  delete recorded._fixture;
  return { ...recorded, session_id: w.sid, cwd: project, ...extra };
};
const ups = (w: Worker, promptId: string, prompt: string) =>
  base(w, "UserPromptSubmit-probe", { prompt_id: promptId, prompt });
const stop = (w: Worker, promptId: string, text: string, background: unknown[] = []) =>
  base(w, "Stop-idle", { prompt_id: promptId, last_assistant_message: text, background_tasks: background });
const claim = (w: Worker, promptId = uuid()) => {
  const r = s.hook(ups(w, promptId, `Implement it.\n\n${w.contract}\n`));
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  return promptId;
};
const phase = (w: Worker) => s.ok(["delegations", w.requestId], { as: LEAD }).delegations[0];
const notices = (w: Worker) =>
  s
    .ok(["read", "--correlation", w.requestId, "--type", "notice", "--limit", "1000"], { as: LEAD })
    .messages.map((m: any) => ({ kind: m.notice.kind, body: m.body, id: m.id }));

describe("unregistered and pending sessions", () => {
  test("hooks for unregistered sessions exit 0 silently and write nothing", () => {
    const before = s.sql(
      "SELECT (SELECT count(*) FROM observations) + (SELECT count(*) FROM messages) AS n",
    )[0].n;
    for (const name of ["SessionStart", "UserPromptSubmit-probe", "Stop-background-running", "SessionEnd"]) {
      const r = s.hook({ ...fixture(`claude/${name}.json`), session_id: uuid() });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(
      s.sql("SELECT (SELECT count(*) FROM observations) + (SELECT count(*) FROM messages) AS n")[0].n,
    ).toBe(before);
    expect(readdirSync(join(s.stateDir, "spool")).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  test("with no store at all, an unregistered hook creates no files", () => {
    const empty = new Store();
    const r = empty.hook(fixture("claude/Stop-idle.json"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(empty.stateDir)).toBe(false);
    empty.cleanup();
  });

  test("quoted, duplicated, wrong-cwd and closed-delegation contracts never claim", () => {
    const w = delegateClaude("claim-checks");
    const quoted = w.contract
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    s.hook(ups(w, uuid(), `See this:\n${quoted}`));
    s.hook(ups(w, uuid(), `${w.contract}\n${w.contract}`));
    s.hook({ ...ups(w, uuid(), w.contract), cwd: s.dir });
    expect(s.ok(["session", "show", w.workerId]).session.pending).toBe(true);
    s.ok(["close", w.requestId], { as: LEAD });
    s.hook(ups(w, uuid(), w.contract));
    expect(s.ok(["session", "show", w.workerId]).session.pending).toBe(true);
  });
});

describe("delegated turn capture", () => {
  test("a contract prompt claims the pending worker; Stop posts the final response as a notice", () => {
    const w = delegateClaude("finisher");
    s.hook(base(w, "SessionStart"));
    const p1 = claim(w);
    expect(s.ok(["session", "show", w.workerId]).session.externalId).toBe(w.sid);
    // The launcher's confirmation bind agrees with the token claim; a different ID conflicts.
    expect(
      s.ok(["session", "bind", w.workerId, "--external-id", w.sid, "--short-id", w.sid.slice(0, 8)])
        .alreadyBound,
    ).toBe(true);
    expect(s.run(["session", "bind", w.workerId, "--external-id", uuid()]).code).toBe(5);
    expect(phase(w).phase).toBe("working");

    const progress = s.ok(["reply", w.requestId, "--type", "progress", "--summary", "50%", "--file", "-"], {
      as: w.workerId,
      input: "halfway",
    });
    expect(progress.attribution).toBe("turn");
    s.hook(stop(w, p1, "I finished the analysis but did not publish a result."));
    const n = notices(w);
    expect(n.map((x: { kind: string }) => x.kind)).toEqual(["turn_finished"]);
    expect(n[0].body).toContain("did not publish a result");
    expect(phase(w).phase).toBe("idle");
    // A repeated identical Stop is recorded but not re-posted.
    s.hook(stop(w, p1, "I finished the analysis but did not publish a result."));
    expect(notices(w)).toHaveLength(1);
  });

  test("an explicit question suppresses the finish notice; a wait-receipt notification continues the turn", () => {
    const w = delegateClaude("asker");
    const p1 = claim(w);
    s.ok(["ack", w.requestId], { as: w.workerId });
    const q = s.ok(
      ["reply", w.requestId, "--type", "question", "--key", "q1", "--summary", "Which DB?", "--file", "-"],
      {
        as: w.workerId,
        input: "Postgres or SQLite?",
      },
    );
    expect(q.attribution).toBe("turn");
    // The worker arms its background wait from inside the bound turn; it times out here.
    const waited = s.run(["wait", "--correlation", w.requestId, "--timeout", "300ms"], { as: w.workerId });
    expect(waited.code).toBe(3);
    const taskId = "b1waittask";
    const tasks = join(s.dir, w.sid, "tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, `${taskId}.output`), waited.stdout);
    s.hook(stop(w, p1, "Asked the parent; waiting.", [{ id: taskId, type: "shell", status: "running" }]));
    expect(notices(w)).toHaveLength(0);
    expect(phase(w)).toMatchObject({ phase: "question", backgroundRunning: 1 });

    s.ok(["reply", q.messageId, "--key", `answer-${q.messageId}`, "--file", "-"], {
      as: LEAD,
      input: "SQLite",
    });
    expect(phase(w).phase).toBe("pending");
    const p2 = uuid();
    const notification = fixture("claude/UserPromptSubmit-task-notification.json").prompt.replace(
      /<task-id>[^<]*<\/task-id>[\s\S]*<output-file>[^<]*<\/output-file>/,
      `<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>${join(tasks, `${taskId}.output`)}</output-file>`,
    );
    s.hook(ups(w, p2, notification));
    expect(phase(w).phase).toBe("working");
    s.ok(
      [
        "reply",
        w.requestId,
        "--type",
        "result",
        "--outcome",
        "success",
        "--key",
        "r",
        "--summary",
        "used SQLite",
        "--file",
        "-",
      ],
      {
        as: w.workerId,
        input: "Done with SQLite",
      },
    );
    s.hook(stop(w, p2, "Published the result."));
    expect(notices(w)).toHaveLength(0);
    expect(phase(w)).toMatchObject({ phase: "done", outcome: "success" });
  });

  test("a question still lets a later interruption surface", () => {
    const w = delegateClaude("asker-crash");
    const p1 = claim(w);
    s.ok(["reply", w.requestId, "--type", "question", "--file", "-"], { as: w.workerId, input: "?" });
    s.hook(stop(w, p1, "waiting", [{ id: "bgw", type: "shell", status: "running" }]));
    s.hook(base(w, "SessionEnd"));
    expect(notices(w).map((n: { kind: string }) => n.kind)).toEqual(["turn_interrupted"]);
    expect(phase(w)).toMatchObject({ phase: "interrupted", pendingQuestion: expect.anything() });
  });

  test("manual prompts and unrelated task notifications are never attributed", () => {
    const manual = delegateClaude("manual");
    const p1 = claim(manual);
    s.hook(stop(manual, p1, "first turn"));
    const p2 = uuid();
    s.hook(ups(manual, p2, "hey, can you also fix the README?"));
    expect(phase(manual).phase).toBe("unknown");
    s.hook(stop(manual, p2, "fixed the README"));
    expect(notices(manual).map((n: { kind: string }) => n.kind)).toEqual(["turn_finished", "tracking_lost"]);
    // A worker reply after supersession is preserved but not attributed to a turn.
    expect(
      s.ok(["reply", manual.requestId, "--type", "progress", "--file", "-"], {
        as: manual.workerId,
        input: "x",
      }).attribution,
    ).toBe("unavailable");

    const unrelated = delegateClaude("unrelated");
    const u1 = claim(unrelated);
    s.hook(stop(unrelated, u1, "started a test run", []));
    s.hook(ups(unrelated, uuid(), fixture("claude/UserPromptSubmit-task-notification.json").prompt));
    expect(phase(unrelated).phase).toBe("unknown");
  });

  test("a task created in the bound turn continues it through inventory provenance", () => {
    const w = delegateClaude("bg-task");
    const p1 = claim(w);
    s.hook(stop(w, p1, "running tests in background", [{ id: "btests", type: "shell", status: "running" }]));
    expect(phase(w).phase).toBe("working");
    const note = fixture("claude/UserPromptSubmit-task-notification.json").prompt.replace(
      /<task-id>[^<]*/,
      "<task-id>btests",
    );
    s.hook(ups(w, uuid(), note));
    expect(phase(w).phase).toBe("working");
  });

  test("permission requests are preserved per occurrence and redact raw tool arguments", () => {
    const w = delegateClaude("perm");
    claim(w);
    const req = fixture("claude/PermissionRequest.synthetic.json");
    delete req._fixture;
    const payload = { ...req, session_id: w.sid, cwd: project, prompt_id: undefined };
    s.hook(payload);
    s.hook(payload);
    const n = notices(w);
    expect(n.map((x: { kind: string }) => x.kind)).toEqual(["permission_request", "permission_request"]);
    expect(n[0].body).toContain("Fetch the status page");
    expect(n[0].body).not.toContain("SECRET");
    expect(phase(w).phase).toBe("permission");
    s.ok(["reply", w.requestId, "--type", "progress", "--file", "-"], { as: w.workerId, input: "resumed" });
    expect(phase(w).phase).toBe("working");
  });

  test("API failures post turn_failed; SessionEnd distinguishes interruption from owner release", () => {
    const failing = delegateClaude("failing");
    const f1 = claim(failing);
    s.hook({ ...base(failing, "StopFailure.synthetic"), prompt_id: f1 });
    expect(notices(failing).map((n: { kind: string }) => n.kind)).toEqual(["turn_failed"]);
    expect(phase(failing).phase).toBe("interrupted");

    const idle = delegateClaude("released");
    const i1 = claim(idle);
    s.hook(stop(idle, i1, "done for now"));
    s.hook(base(idle, "SessionEnd"));
    expect(notices(idle).map((n: { kind: string }) => n.kind)).toEqual(["turn_finished"]);
    expect(phase(idle)).toMatchObject({ phase: "idle", state: "open" });

    const busy = delegateClaude("killed");
    claim(busy);
    s.hook(base(busy, "SessionEnd"));
    expect(notices(busy).map((n: { kind: string }) => n.kind)).toEqual(["turn_interrupted"]);
    expect(phase(busy).state).toBe("open");
  });

  test("oversized final text is truncated with an explicit marker and original length", () => {
    const w = delegateClaude("verbose");
    const p1 = claim(w);
    s.hook(stop(w, p1, "я".repeat(700_000)));
    const msg = s.ok(["read", "--correlation", w.requestId, "--type", "notice"], { as: LEAD }).messages[0];
    expect(msg.notice.truncated).toBe(true);
    expect(msg.notice.originalBytes).toBe(1_400_000);
    expect(msg.body).toContain("excerpt truncated");
  });
});

describe("spool", () => {
  test("a spooled event survives, drains once, and malformed files do not block valid ones", () => {
    const w = delegateClaude("spooled");
    const p1 = claim(w);
    const spool = join(s.stateDir, "spool");
    s.hook(stop(w, p1, "spooled final"), { AGENTBUS_FAULT_INJECT: "hook-spool" });
    const files = readdirSync(spool).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(notices(w)).toHaveLength(1); // read drained it before reading
    expect(readdirSync(spool).filter((f) => f.endsWith(".json"))).toHaveLength(0);

    // Replaying the identical captured event ingests once.
    const quarantineDir = join(spool, "quarantine");
    s.hook(stop(w, p1, "second final"), { AGENTBUS_FAULT_INJECT: "hook-spool" });
    const second = readdirSync(spool).filter((f) => f.endsWith(".json"))[0]!;
    copyFileSync(join(spool, second), join(s.dir, "replay.json"));
    writeFileSync(join(spool, "0000-bad.json"), "{ not json");
    writeFileSync(join(spool, ".tmp-123-partial"), "{");
    const drained = s.ok(["event", "drain"]);
    expect(drained).toMatchObject({ ingested: 1, quarantined: 1, remaining: 0 });
    expect(readdirSync(quarantineDir)).toContain("0000-bad.json");
    copyFileSync(join(s.dir, "replay.json"), join(spool, second));
    expect(s.ok(["event", "drain"])).toMatchObject({ ingested: 0, duplicates: 1 });
    expect(notices(w)).toHaveLength(2);
    expect(s.ok(["status"]).spool.quarantined).toBe(1);
  });

  test("an already armed wait discovers a spool-only event", async () => {
    const w = delegateClaude("spool-wake");
    const p1 = claim(w);
    s.ok(["read"], { as: LEAD }); // settle the backlog
    const pending = s.ok(["read", "--limit", "1000"], { as: LEAD }).messages.map((m: any) => m.id);
    if (pending.length)
      for (let i = 0; i < pending.length; i += 100) s.ok(["ack", ...pending.slice(i, i + 100)], { as: LEAD });
    const waiter = s.runAsync(["wait", "--timeout", "10s", "--type", "notice"], { as: LEAD });
    await sleep(700);
    s.hook(stop(w, p1, "only in the spool"), { AGENTBUS_FAULT_INJECT: "hook-spool" });
    const r = await waiter;
    expect(r.code).toBe(0);
    expect(r.json?.data.messages[0].body).toContain("only in the spool");
  });
});
