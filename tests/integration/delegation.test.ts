import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../harness.ts";

let s: Store;
let projectDir: string;

beforeAll(() => {
  s = new Store().init();
  s.register("generic", "lead", "lead");
  projectDir = join(s.dir, "project");
  mkdirSync(projectDir);
});
afterAll(() => s.cleanup());

const LEAD = "generic:lead";
const delegate = (body: string, extra: string[] = []) =>
  s.ok(["delegate", "--to", "claude", "--cwd", projectDir, "--file", "-", ...extra], {
    as: LEAD,
    input: body,
  });

describe("delegate", () => {
  test("opens a pending worker, request and delegation with a contract", () => {
    const d = delegate("Do the thing", ["--name", "impl", "--label", "model=opus", "--summary", "thing"]);
    expect(d.duplicate).toBe(false);
    expect(d.delegation.phase).toBe("pending");
    expect(d.returnPath).toBe("manual");
    expect(d.contract).toContain(`agentbus-request: ${d.requestId}`);
    expect(d.contract).toContain(`--as ${d.workerId}`);
    expect(d.contract).toContain(`--state-dir ${s.stateDir}`);
    const worker = s.ok(["session", "show", d.workerId]).session;
    expect(worker.pending).toBe(true);
    expect(worker.labels).toEqual({ model: "opus" });
    const req = s.ok(["read", "--type", "request"], { as: d.workerId }).messages[0];
    expect(req.id).toBe(d.requestId);
    expect(req.body).toBe("Do the thing");
  });

  test("a keyed retry returns the same worker, request and contract even after closure; changed intent conflicts", () => {
    const a = delegate("Keyed task", ["--key", "task-1", "--name", "keyed"]);
    s.ok(["close", a.requestId], { as: LEAD });
    const b = delegate("Keyed task", ["--key", "task-1", "--name", "keyed"]);
    expect(b).toMatchObject({
      workerId: a.workerId,
      requestId: a.requestId,
      contract: a.contract,
      duplicate: true,
    });
    const c = s.run(
      [
        "delegate",
        "--to",
        "claude",
        "--cwd",
        projectDir,
        "--file",
        "-",
        "--key",
        "task-1",
        "--name",
        "renamed",
      ],
      {
        as: LEAD,
        input: "Keyed task",
      },
    );
    expect(c.code).toBe(5);
    const workers = s.sql("SELECT count(*) AS n FROM sessions WHERE name = 'keyed'")[0];
    expect(workers.n).toBe(1);
  });

  test("a failed contract file write is recoverable through a keyed retry without another worker", () => {
    const bad = join(s.dir, "missing-file-as-dir");
    mkdirSync(bad);
    const r = s.run(
      ["delegate", "--to", "codex", "--cwd", projectDir, "--file", "-", "--key", "cf", "--contract-out", bad],
      {
        as: LEAD,
        input: "contract file",
      },
    );
    expect(r.code).toBe(1);
    expect(r.json?.error.code).toBe("contract_write_failed");
    const out = join(s.dir, "contract.md");
    const retry = s.ok(
      ["delegate", "--to", "codex", "--cwd", projectDir, "--file", "-", "--key", "cf", "--contract-out", out],
      {
        as: LEAD,
        input: "contract file",
      },
    );
    expect(retry.workerId).toBe(r.json?.error.details.workerId);
    expect(readFileSync(out, "utf8")).toContain(retry.requestId);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  test("Claude workers get a private per-worker hook settings file; Codex workers do not", () => {
    const d = delegate("Hooked worker", ["--key", "hooked"]);
    expect(d.claudeSettings).toBe(join(s.stateDir, "workers", d.workerId, "claude-settings.json"));
    expect(statSync(d.claudeSettings).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(readFileSync(d.claudeSettings, "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "PermissionRequest",
      "PostToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "StopFailure",
      "UserPromptSubmit",
    ]);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(`--state-dir ${s.stateDir}`);
    // A keyed retry recreates a missing file without creating another worker.
    rmSync(d.claudeSettings);
    expect(delegate("Hooked worker", ["--key", "hooked"]).workerId).toBe(d.workerId);
    expect(existsSync(d.claudeSettings)).toBe(true);
    const codex = s.ok(["delegate", "--to", "codex", "--file", "-"], { as: LEAD, input: "codex" });
    expect(codex.claudeSettings).toBeNull();
    expect(existsSync(join(s.stateDir, "workers", codex.workerId))).toBe(false);
  });

  test("dry-run prints the contract with preview IDs and writes nothing", () => {
    const before = s.sql("SELECT count(*) AS n FROM messages")[0].n;
    const out = join(s.dir, "dry.md");
    const r = s.ok(["delegate", "--to", "claude", "--file", "-", "--dry-run", "--contract-out", out], {
      as: LEAD,
      input: "x",
    });
    expect(r.dryRun).toBe(true);
    expect(r.workerId).toStartWith("preview-");
    expect(existsSync(join(s.stateDir, "workers", r.workerId))).toBe(false);
    expect(s.sql("SELECT count(*) AS n FROM messages")[0].n).toBe(before);
    expect(existsSync(out)).toBe(false);
  });
});

describe("roles and terminal states", () => {
  test("task replies flow from worker to parent; wrong roles and shapes are rejected", () => {
    const d = delegate("Role checks");
    const w = d.workerId;
    // Identity leak: the parent cannot acknowledge or reply to the worker's request.
    expect(s.run(["ack", d.requestId], { as: LEAD }).code).toBe(5);
    expect(
      s.run(["reply", d.requestId, "--type", "progress", "--file", "-"], { as: LEAD, input: "x" }).code,
    ).toBe(5);
    s.ok(["ack", d.requestId], { as: w });
    expect(
      s.run(["reply", d.requestId, "--type", "request", "--file", "-"], { as: w, input: "x" }).code,
    ).toBe(2);
    expect(
      s.run(["reply", d.requestId, "--type", "progress", "--outcome", "success", "--file", "-"], {
        as: w,
        input: "x",
      }).code,
    ).toBe(2);
    expect(s.run(["reply", d.requestId, "--type", "result", "--file", "-"], { as: w, input: "x" }).code).toBe(
      2,
    );
    expect(s.run(["send", LEAD, "--type", "progress", "--file", "-"], { as: w, input: "x" }).code).toBe(2);

    const p = s.ok(["reply", d.requestId, "--type", "progress", "--summary", "halfway", "--file", "-"], {
      as: w,
      input: "50%",
    });
    expect(p.attribution).toBe("unavailable");
    const q = s.ok(
      ["reply", d.requestId, "--type", "question", "--summary", "Which config?", "--file", "-"],
      { as: w, input: "A or B" },
    );
    expect(s.ok(["delegations", d.requestId], { as: LEAD }).delegations[0].phase).toBe("question");
    // One unresolved question at a time.
    expect(
      s.run(["reply", d.requestId, "--type", "question", "--file", "-"], { as: w, input: "another" }).json
        ?.error.code,
    ).toBe("question_pending");
    // Acknowledging the question does not resolve it.
    s.ok(["ack", q.messageId], { as: LEAD });
    expect(s.ok(["delegations", d.requestId], { as: LEAD }).delegations[0].phase).toBe("question");
    const answer = s.ok(["reply", q.messageId, "--key", `answer-${q.messageId}`, "--file", "-"], {
      as: LEAD,
      input: "B",
    });
    expect(answer.to).toBe(w);
    expect(s.ok(["delegations", d.requestId], { as: LEAD }).delegations[0].phase).toBe("pending");

    const r = s.ok(
      [
        "reply",
        d.requestId,
        "--type",
        "result",
        "--outcome",
        "success",
        "--key",
        "res",
        "--summary",
        "done",
        "--file",
        "-",
      ],
      {
        as: w,
        input: "All done",
      },
    );
    expect(r.delegation).toMatchObject({ state: "done", phase: "done", outcome: "success" });
    // Exact keyed retry after closure returns the original receipt; new task messages are refused.
    const again = s.ok(
      [
        "reply",
        d.requestId,
        "--type",
        "result",
        "--outcome",
        "success",
        "--key",
        "res",
        "--summary",
        "done",
        "--file",
        "-",
      ],
      {
        as: w,
        input: "All done",
      },
    );
    expect(again).toMatchObject({ messageId: r.messageId, duplicate: true });
    expect(
      s.run(["reply", d.requestId, "--type", "result", "--outcome", "failed", "--file", "-"], {
        as: w,
        input: "late",
      }).code,
    ).toBe(5);
    expect(
      s.run(["reply", d.requestId, "--type", "progress", "--file", "-"], { as: w, input: "late" }).code,
    ).toBe(5);
    expect(s.ok(["close", d.requestId], { as: LEAD })).toMatchObject({ state: "done", changed: false });
  });

  test("one open delegation per worker and no self-delegation", () => {
    const d = delegate("Exclusive");
    const second = s.run(["send", d.workerId, "--type", "request", "--file", "-"], {
      as: LEAD,
      input: "more",
    });
    expect(second.code).toBe(5);
    expect(second.json?.error.code).toBe("worker_busy");
    expect(s.run(["send", LEAD, "--type", "request", "--file", "-"], { as: LEAD, input: "me" }).code).toBe(2);
    s.ok(["close", d.requestId], { as: LEAD });
    const reopened = s.ok(["send", d.workerId, "--type", "request", "--file", "-"], {
      as: LEAD,
      input: "fresh request",
    });
    expect(reopened.delegation.state).toBe("open");
  });

  test("only the parent closes; close is idempotent and never needs the worker", () => {
    const d = delegate("Closable", ["--name", "closable"]);
    expect(s.run(["close", d.requestId], { as: d.workerId }).code).toBe(5);
    expect(s.ok(["close", "closable"], { as: LEAD })).toMatchObject({ state: "closed", changed: true });
    expect(s.ok(["close", d.requestId], { as: LEAD })).toMatchObject({ state: "closed", changed: false });
    expect(s.ok(["delegations", d.requestId], { as: LEAD }).delegations[0].phase).toBe("closed");
  });

  test("notices cannot be authored or replied to through public commands", () => {
    expect(
      s.run(["send", "generic:lead", "--type", "notice", "--file", "-"], { as: LEAD, input: "x" }).code,
    ).toBe(2);
    expect(
      s.run(["reply", crypto.randomUUID(), "--type", "notice", "--file", "-"], { as: LEAD, input: "x" }).code,
    ).toBe(2);
  });

  test("delegations lists open and recent work with phases and labels", () => {
    const list = s.ok(["delegations"], { as: LEAD }).delegations;
    expect(list.length).toBeGreaterThan(3);
    for (const v of list)
      expect(["pending", "question", "done", "closed", "working", "idle"]).toContain(v.phase);
    const human = s.run(["delegations"], { as: LEAD, json: false });
    expect(human.stdout).toContain("PHASE");
  });
});
