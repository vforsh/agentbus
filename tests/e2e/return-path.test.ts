// Return-path readiness from current evidence: live wait arms (process and owner identity, coverage, expiry)
// and heartbeat check-ins with a freshness window. Real wait processes; no provider sessions.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BIN, Store, sleep, uuid } from "../harness.ts";

let s: Store;
const LEAD = `claude:${uuid()}`;
const CODEX = `codex:${uuid()}`;
let leadId: string;

beforeAll(() => {
  s = new Store().init();
  leadId = s.register("claude", LEAD.slice(7), "lead");
  s.register("codex", CODEX.slice(6), "planner");
});
afterAll(() => s.cleanup());

const delegate = (as: string, name: string) =>
  s.ok(["delegate", "--to", "codex", "--name", name, "--file", "-"], { as, input: `task ${name}` });
const view = (as: string, requestId: string) => s.ok(["delegations", requestId], { as }).delegations[0];
const openArms = (session = leadId) =>
  s.sql<{ id: string; process: string | null; created_at: string }>(
    "SELECT id, process, created_at FROM wait_arms WHERE session_id = ? AND ended_at IS NULL ORDER BY created_at",
    session,
  );

/** Starts a wait and resolves once its own arm is recorded; it is then the session's only unended arm. */
async function startWait(args: string[], as = LEAD, session = leadId) {
  const since = new Date().toISOString();
  const proc = s.spawn(["wait", "--replace", ...args], { as });
  return { proc, arm: await armSince(since, session) };
}

async function armSince(since: string, session = leadId) {
  const fresh = () => openArms(session).filter((a) => a.created_at >= since);
  for (let i = 0; i < 200 && fresh().length === 0; i++) await sleep(25);
  expect(fresh()).toHaveLength(1);
  return fresh()[0]!;
}

function bindingFile(binding: Record<string, unknown>): string {
  const path = join(s.dir, `rb-${uuid()}.json`);
  writeFileSync(path, JSON.stringify(binding));
  return path;
}

describe("background wait readiness", () => {
  test("a reported ready binding without a watcher is not ready", () => {
    const d = delegate(LEAD, "reported");
    expect(d).toMatchObject({ returnPath: "background_wait", returnPathStatus: "setup_required" });
    const upd = s.ok(
      [
        "session",
        "update",
        LEAD,
        "--binding-file",
        bindingFile({ strategy: "background_wait", status: "ready" }),
      ],
      {},
    );
    expect(upd.returnReadiness).toMatchObject({ status: "setup_required", readiness: "not_armed" });
    const v = view(LEAD, d.requestId);
    expect(v.returnPathStatus).toBe("setup_required");
    expect(v.returnReadiness).toMatchObject({
      readiness: "not_armed",
      source: "none",
      reported: { strategy: "background_wait", status: "ready" },
    });
  });

  test("a timed-out wait leaves no armed path and says why", () => {
    const d = delegate(LEAD, "timed-out");
    expect(s.run(["wait", "--replace", "--timeout", "1ms"], { as: LEAD }).code).toBe(3);
    expect(openArms()).toHaveLength(0);
    const rr = view(LEAD, d.requestId).returnReadiness;
    expect(rr).toMatchObject({
      status: "setup_required",
      readiness: "not_armed",
      watcher: { endReason: "timeout" },
    });
    expect(rr.reason).toContain("timed out");
  });

  test("a live watcher arms every delegation, including ones opened after it; supersession keeps it armed", async () => {
    const before = delegate(LEAD, "before-arm");
    const { proc: first } = await startWait(["--timeout", "60s"]);
    expect(view(LEAD, before.requestId).returnReadiness).toMatchObject({
      status: "ready",
      readiness: "armed",
      source: "wait_arm",
      watcher: { scope: "all", pid: first.pid },
    });
    // Start identities compare in UTC: a checker in another time zone still sees the same process.
    const elsewhere = s.ok(["delegations", before.requestId], {
      as: LEAD,
      env: { TZ: "Pacific/Kiritimati" },
    });
    expect(elsewhere.delegations[0].returnReadiness.readiness).toBe("armed");
    const after = delegate(LEAD, "after-arm");
    expect(after).toMatchObject({ returnPathStatus: "ready", returnReadiness: { readiness: "armed" } });

    const { proc: second, arm } = await startWait(["--timeout", "60s"]);
    expect(await first.exited).toBe(0);
    expect(JSON.parse(arm.process!).pid).toBe(second.pid);
    expect(view(LEAD, after.requestId).returnReadiness).toMatchObject({
      readiness: "armed",
      watcher: { pid: second.pid },
    });

    second.kill("SIGINT");
    expect(await second.exited).toBe(130);
    const rr = view(LEAD, after.requestId).returnReadiness;
    expect(rr).toMatchObject({ readiness: "not_armed", watcher: { endReason: "interrupted" } });
  });

  test("a killed watcher (no recorded exit) is not armed", async () => {
    const d = delegate(LEAD, "crashed");
    const { proc: w } = await startWait(["--timeout", "60s"]);
    w.kill("SIGKILL");
    await w.exited;
    expect(openArms()).toHaveLength(1);
    const rr = view(LEAD, d.requestId).returnReadiness;
    expect(rr).toMatchObject({
      status: "setup_required",
      readiness: "not_armed",
      watcher: { state: "dead" },
    });
    expect(rr.reason).toContain("without recording an exit");
  });

  test("a watcher whose owner exited is orphaned, not armed", async () => {
    const d = delegate(LEAD, "orphaned");
    const cmd = [BIN, "--as", LEAD, "wait", "--replace", "--timeout", "60s"].map((a) => `'${a}'`).join(" ");
    const since = new Date().toISOString();
    const owner = Bun.spawn(["sh", "-c", `${cmd} >/dev/null 2>&1 & sleep 30`], {
      env: s.env(),
      stdout: "ignore",
      stderr: "ignore",
    });
    const arm = await armSince(since);
    expect(view(LEAD, d.requestId).returnReadiness.readiness).toBe("armed");
    owner.kill("SIGKILL");
    await owner.exited;
    const rr = view(LEAD, d.requestId).returnReadiness;
    expect(rr).toMatchObject({
      status: "setup_required",
      readiness: "owner_lost",
      watcher: { state: "owner_lost" },
    });
    process.kill(JSON.parse(arm.process!).pid, "SIGINT");
    for (let i = 0; i < 100 && openArms().length > 0; i++) await sleep(25);
  });

  test("unverifiable evidence stays unknown: legacy arms and a failing ps", async () => {
    const d = delegate(LEAD, "unverified");
    s.sqlWrite(
      "INSERT INTO wait_arms (id, session_id, correlation, created_at) VALUES (?, ?, NULL, ?)",
      uuid(),
      leadId,
      new Date().toISOString(),
    );
    expect(view(LEAD, d.requestId)).toMatchObject({
      returnPathStatus: "unknown",
      returnReadiness: { readiness: "unverified" },
    });
    s.sqlWrite(
      "UPDATE wait_arms SET ended_at = ?, end_reason = 'test' WHERE process IS NULL",
      new Date().toISOString(),
    );

    const { proc: w } = await startWait(["--timeout", "60s"]);
    // No `ps` on PATH: liveness cannot be established, which is not evidence of death.
    const bin = join(s.dir, "bin-no-ps");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "bun"));
    const blind = s.ok(["delegations", d.requestId], { as: LEAD, env: { PATH: bin } }).delegations[0];
    expect(blind.returnReadiness).toMatchObject({ status: "unknown", readiness: "unverified" });
    w.kill("SIGINT");
    await w.exited;
  });

  test("an unended arm past its timeout is expired", () => {
    const d = delegate(LEAD, "expired");
    const self = JSON.stringify({ pid: process.pid, start: "Thu Jan  1 00:00:00 1970" });
    s.sqlWrite(
      "INSERT INTO wait_arms (id, session_id, created_at, scope, process, owner, expires_at) VALUES (?, ?, ?, 'all', ?, '[]', ?)",
      uuid(),
      leadId,
      new Date(Date.now() - 3_600_000).toISOString(),
      self,
      new Date(Date.now() - 600_000).toISOString(),
    );
    const rr = view(LEAD, d.requestId).returnReadiness;
    expect(rr).toMatchObject({ readiness: "not_armed", watcher: { state: "expired" } });
    s.sqlWrite(
      "UPDATE wait_arms SET ended_at = ?, end_reason = 'test' WHERE ended_at IS NULL",
      new Date().toISOString(),
    );
  });

  test("coverage: a correlated or filtered wait does not arm other delegations; a settled snapshot excludes later ones", async () => {
    const a = delegate(LEAD, "cov-a");
    const b = delegate(LEAD, "cov-b");
    const { proc: corr } = await startWait(["--correlation", a.requestId, "--timeout", "60s"]);
    expect(view(LEAD, a.requestId).returnReadiness.readiness).toBe("armed");
    expect(view(LEAD, b.requestId).returnReadiness.readiness).toBe("not_armed");
    const { proc: filtered } = await startWait(["--type", "result", "--timeout", "60s"]);
    expect(await corr.exited).toBe(0);
    expect(view(LEAD, a.requestId).returnReadiness.readiness).toBe("not_armed");
    const { proc: settled } = await startWait(["--settled", "--timeout", "60s"]);
    expect(await filtered.exited).toBe(0);
    expect(view(LEAD, b.requestId).returnReadiness.readiness).toBe("armed");
    const later = delegate(LEAD, "cov-later");
    expect(later.returnReadiness.readiness).toBe("not_armed");
    settled.kill("SIGINT");
    await settled.exited;
  });

  test("doctor reports the caller's return path", async () => {
    const env = { CLAUDE_CODE_SESSION_ID: LEAD.slice(7) };
    const cold = s.run(["doctor"], { env }).json?.data.checks.find((c: any) => c.name === "return_path");
    expect(cold).toMatchObject({ status: "warn" });
    const { proc: w } = await startWait(["--timeout", "60s"]);
    const warm = s.run(["doctor"], { env }).json?.data.checks.find((c: any) => c.name === "return_path");
    expect(warm).toMatchObject({ status: "ok" });
    w.kill("SIGINT");
    await w.exited;
  });
});

describe("heartbeat readiness", () => {
  test("no check-in is not ready; a fresh one is reported; a stale one is unknown; refresh renews it", () => {
    const d = delegate(CODEX, "beat");
    expect(d).toMatchObject({ returnPath: "heartbeat", returnPathStatus: "setup_required" });
    expect(s.run(["session", "update", CODEX, "--refresh"]).code).toBe(4);

    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    s.ok([
      "session",
      "update",
      CODEX,
      "--binding-file",
      bindingFile({ strategy: "heartbeat", status: "ready", handle: "hb-1", interval: "5m", checkedAt: old }),
    ]);
    expect(view(CODEX, d.requestId)).toMatchObject({
      returnPathStatus: "unknown",
      returnReadiness: {
        readiness: "stale",
        source: "parent_report",
        reported: { handle: "hb-1", fresh: false },
      },
    });

    const refreshed = s.ok(["session", "update", CODEX, "--refresh"]);
    expect(refreshed.returnReadiness).toMatchObject({ status: "ready", readiness: "reported" });
    expect(view(CODEX, d.requestId)).toMatchObject({
      returnPathStatus: "ready",
      returnReadiness: { readiness: "reported" },
    });
    expect(delegate(CODEX, "beat-2").returnPathStatus).toBe("ready");

    s.ok([
      "session",
      "update",
      CODEX,
      "--binding-file",
      bindingFile({ strategy: "heartbeat", status: "unsupported" }),
    ]);
    expect(view(CODEX, d.requestId).returnReadiness).toMatchObject({
      status: "unsupported",
      readiness: "unsupported",
    });
    const bad = s.run([
      "session",
      "update",
      CODEX,
      "--binding-file",
      bindingFile({ strategy: "heartbeat", status: "ready", interval: "soon" }),
    ]);
    expect(bad.code).toBe(2);
  });

  test("a heartbeat's in-turn wait counts while it runs", async () => {
    s.ok([
      "session",
      "update",
      CODEX,
      "--binding-file",
      bindingFile({ strategy: "heartbeat", status: "ready" }),
    ]);
    const d = delegate(CODEX, "beat-wait");
    const codexId = s.ok(["whoami"], { as: CODEX }).session.id;
    const { proc: w } = await startWait(["--timeout", "60s"], CODEX, codexId);
    expect(view(CODEX, d.requestId).returnReadiness).toMatchObject({
      readiness: "armed",
      source: "wait_arm",
    });
    w.kill("SIGINT");
    await w.exited;
    expect(view(CODEX, d.requestId).returnReadiness).toMatchObject({ readiness: "reported" });
  });
});
