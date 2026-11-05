// Public CLI only, real SQLite receipts, wait subprocesses and OS process evidence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, sleep } from "../harness.ts";

let s: Store;
let parent: string;
beforeEach(() => {
  s = new Store().init();
  parent = s.register("generic", "parent");
});
afterEach(() => s.cleanup());
const metrics = () => s.ok(["metrics"], { as: parent });
const delegate = (as = parent) =>
  s.ok(["delegate", "--to", "claude", "--cwd", s.dir, "--file", "-"], { as, input: "private task body" });
const reply = (w: any, type: string, extra: string[] = []) =>
  s.ok(["reply", w.requestId, "--type", type, ...extra, "--file", "-"], {
    as: w.workerId,
    input: "private reply body",
  });
const followup = (w: any) =>
  s.ok(["followup", w.requestId, "--file", "-"], { as: parent, input: "private followup body" });
const dbBytes = () => readFileSync(join(s.stateDir, "agentbus.sqlite3"));
const stamp = (id: string, at: string) =>
  s.sqlWrite("UPDATE messages SET created_at = ? WHERE id = ?", at, id);

async function arm() {
  const proc = s.spawn(["wait", "--timeout", "60s"], { as: parent });
  try {
    for (let i = 0; i < 100; i++) {
      const row = s.sql("SELECT * FROM wait_arms WHERE ended_at IS NULL")[0];
      if (row) return { proc, row };
      await sleep(20);
    }
    throw new Error("wait never armed");
  } catch (e) {
    proc.kill();
    await proc.exited;
    throw e;
  }
}

describe("metrics CLI", () => {
  test("empty, versioned output, global fallback without identity, human and plain", () => {
    const m = metrics();
    expect(m).toMatchObject({
      metricsVersion: 2,
      units: "ms",
      scope: { kind: "parent", parentId: parent },
      delegations: { total: 0, withoutResult: 0 },
    });
    expect(m.results.count).toBe(0);
    expect(m.results.commitToSeen).toEqual({
      measured: 0,
      pending: 0,
      missing: 0,
      settled: 0,
      invalid: 0,
      unobserved: 0,
      minMs: null,
      maxMs: null,
      meanMs: null,
      p50Ms: null,
      p90Ms: null,
      p95Ms: null,
    });
    expect(m.questions).toEqual({ count: 0, unseen: 0, oldest: null });
    expect(m.followups.oldest).toBeNull();
    expect(m.watchers).toMatchObject({ total: 0, stale: 0, dead: 0, unverified: 0, items: [] });
    expect(s.ok(["metrics"]).scope).toEqual({ kind: "global", parentId: null });
    expect(s.ok(["metrics", "--global"]).scope).toEqual({ kind: "global", parentId: null });
    expect(s.run(["metrics"], { as: parent, json: false }).stdout).toContain("commitToSeen: 0 measured");
    expect(s.run(["metrics", "--plain"], { as: parent, json: false }).stdout).toContain(
      "latency\tcommitToSeen\t0\t0\t0\t0\t0\t-\t-\t-",
    );
  });

  test("result → read (unchanged) → wait/seen → ack; uses the persisted timestamp differences", () => {
    const w = delegate();
    expect(metrics().delegations.withoutResult).toBe(1);
    const result = reply(w, "result", ["--outcome", "success"]);
    const id = result.messageId;
    stamp(id, new Date(Date.now() - 10_000).toISOString());
    let m = metrics();
    expect(m.results.count).toBe(1);
    expect(m.results.commitToSeen).toMatchObject({ pending: 1, measured: 0, minMs: null });
    expect(m.results.seenToAck.pending).toBe(1);
    expect(m.results.awaitingSeen.oldest.messageId).toBe(id);
    const beforeRead = dbBytes();
    s.ok(["read"], { as: parent });
    expect(dbBytes()).toEqual(beforeRead);
    s.ok(["wait", "--timeout", "1s"], { as: parent });
    m = metrics();
    const receipt = s.sql("SELECT seen_at, acknowledged_at FROM receipts WHERE message_id = ?", id)[0];
    const created = s.sql("SELECT created_at FROM messages WHERE id = ?", id)[0].created_at;
    const deliveryMs = Date.parse(receipt.seen_at) - Date.parse(created);
    expect(m.results.commitToSeen).toMatchObject({
      measured: 1,
      pending: 0,
      minMs: deliveryMs,
      maxMs: deliveryMs,
      meanMs: deliveryMs,
    });
    expect(m.results.seenToAck).toMatchObject({ measured: 0, pending: 1 });
    expect(m.results.awaitingSeen.count).toBe(0);
    expect(m.results.awaitingAck.count).toBe(1);
    s.ok(["ack", id], { as: parent });
    const ack = s.sql("SELECT acknowledged_at FROM receipts WHERE message_id = ?", id)[0].acknowledged_at;
    m = metrics();
    expect(m.results.seenToAck.minMs).toBe(Date.parse(ack) - Date.parse(receipt.seen_at));
    expect(m.results.commitToAck.minMs).toBe(Date.parse(ack) - Date.parse(created));
    expect(m.results.awaitingAck.oldest).toBeNull();
  });

  test("direct ack records seen at ack: real zero differs from pending, missing, invalid and settlement", () => {
    const w = delegate();
    const id = reply(w, "result", ["--outcome", "success"]).messageId;
    s.ok(["ack", id], { as: parent });
    expect(metrics().results.seenToAck).toMatchObject({ measured: 1, minMs: 0, maxMs: 0, meanMs: 0 });
    const at = "2026-01-01T00:00:00.000Z";
    stamp(id, at);
    s.sqlWrite("UPDATE receipts SET seen_at = ?, acknowledged_at = ? WHERE message_id = ?", at, at, id);
    expect(metrics().results.commitToSeen.minMs).toBe(0);
    s.sqlWrite("UPDATE receipts SET seen_at = '2025-01-01' WHERE message_id = ?", id);
    expect(metrics().results.commitToSeen).toMatchObject({ invalid: 1, measured: 0, minMs: null });
    s.sqlWrite("UPDATE receipts SET settled_reason = 'delegation_closed' WHERE message_id = ?", id);
    expect(metrics().results.commitToAck).toMatchObject({ settled: 1, measured: 0 });
    // Simulate historical missing evidence, never fabricate a zero latency.
    s.sqlWrite("DELETE FROM receipts WHERE message_id = ?", id);
    expect(metrics().results.commitToSeen).toMatchObject({ missing: 1, pending: 0, minMs: null });
  });

  test("oldest unanswered question survives ack; followups include answers and seen but unacked mail", () => {
    const w = delegate();
    const q = reply(w, "question").messageId;
    const f = followup(w).messageId;
    stamp(q, "2026-01-01T00:00:00.000Z");
    stamp(f, "2026-01-02T00:00:00.000Z");
    s.ok(["ack", q], { as: parent });
    s.ok(["wait", "--correlation", w.requestId, "--timeout", "1s"], { as: w.workerId });
    let m = metrics();
    expect(m.questions.count).toBe(1);
    expect(m.questions.oldest.messageId).toBe(q);
    expect(m.questions.oldest.ageMs).toBe(Date.parse(m.snapshotAt) - Date.parse("2026-01-01"));
    expect(m.followups).toMatchObject({ count: 1, unseen: 0, oldest: { messageId: f } });
    const a = s.ok(["reply", q, "--file", "-"], { as: parent, input: "SQLite" }).messageId;
    m = metrics();
    expect(m.questions.oldest).toBeNull();
    expect(m.followups.count).toBe(2);
    expect(m.followups.oldest.messageId).toBe(f);
    s.ok(["ack", f], { as: w.workerId });
    expect(metrics().followups.oldest.messageId).toBe(a);
    reply(w, "result", ["--outcome", "failed"]);
    expect(metrics().followups.count).toBe(0); // settled leftovers are no longer active backlog
  });

  test("oldest spans delegations; close removes pending questions and followups", () => {
    const w1 = delegate();
    const w2 = delegate();
    const q1 = reply(w1, "question").messageId;
    const q2 = reply(w2, "question").messageId;
    const f1 = followup(w1).messageId;
    const f2 = followup(w2).messageId;
    stamp(q1, "2026-01-02T00:00:00.000Z");
    stamp(q2, "2026-01-01T00:00:00.000Z");
    stamp(f1, "2026-01-02T00:00:00.000Z");
    stamp(f2, "2026-01-01T00:00:00.000Z");
    expect(metrics().questions).toMatchObject({ count: 2, oldest: { messageId: q2 } });
    expect(metrics().followups.oldest.messageId).toBe(f2);
    s.ok(["close", w2.requestId], { as: parent });
    expect(metrics().questions.oldest.messageId).toBe(q1);
    expect(metrics().followups.oldest.messageId).toBe(f1);
  });

  test("parent scope isolates history, backlogs, unrelated mail and worker waits", () => {
    const other = s.register("generic", "other");
    const own = delegate();
    const foreign = delegate(other);
    reply(own, "result", ["--outcome", "success"]);
    reply(foreign, "question");
    const foreignDone = delegate(other);
    reply(foreignDone, "result", ["--outcome", "success"]);
    s.ok(["followup", foreign.requestId, "--file", "-"], { as: other, input: "other backlog" });
    s.ok(["send", parent, "--file", "-"], { as: other, input: "unrelated" });
    s.sqlWrite(
      "INSERT INTO wait_arms (id, session_id, created_at) VALUES ('foreign-wait', ?, ?)",
      foreign.workerId,
      new Date().toISOString(),
    );
    s.sqlWrite(
      "INSERT INTO wait_arms (id, session_id, created_at) VALUES ('own-wait', ?, ?)",
      own.workerId,
      new Date().toISOString(),
    );
    const mine = metrics();
    expect(mine.delegations.total).toBe(1);
    expect(mine.results.count).toBe(1);
    expect(mine.questions.count).toBe(0);
    expect(mine.followups.count).toBe(0);
    expect(mine.watchers.items.map((w: any) => w.armId)).toEqual(["own-wait"]);
    const global = s.ok(["metrics", "--global"]);
    expect(global.delegations.total).toBe(3);
    expect(global.results.count).toBe(2);
    expect(global.questions.count).toBe(1);
    expect(global.followups.count).toBe(1);
    expect(global.watchers.unverified).toBe(2);
  });

  test("metrics preserve database bytes and queued spool, omit bodies, and call no providers", () => {
    const w = delegate();
    reply(w, "question");
    followup(w);
    const queued = join(s.stateDir, "spool", "pending.json");
    writeFileSync(queued, '{"pending":"do not drain"}');
    const provider = join(s.dir, "provider");
    const marker = join(s.dir, "provider-called");
    writeFileSync(provider, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
    s.ok(["config", "set", `claudeBin=${provider}`, `codexBin=${provider}`]);
    const before = dbBytes();
    const output = s.run(["metrics"], { as: parent });
    expect(output.code).toBe(0);
    expect(output.stdout).not.toContain("private");
    expect(dbBytes()).toEqual(before);
    expect(readFileSync(queued, "utf8")).toBe('{"pending":"do not drain"}');
    expect(readdirSync(s.dir)).not.toContain("provider-called");
  });

  test("real live and killed watchers; expired is independent of confirmed death; owner lost and legacy unknown", async () => {
    const { proc, row } = await arm();
    try {
      let w = metrics().watchers;
      expect(w).toMatchObject({ unended: 1, live: 1, dead: 0, unverified: 0, stale: 0 });
      s.sqlWrite("UPDATE wait_arms SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", row.id);
      w = metrics().watchers;
      expect(w).toMatchObject({ live: 1, dead: 0, expired: 1, stale: 1 });
      expect(w.items[0].processLiveness).toBe("alive");
      s.sqlWrite(
        "UPDATE wait_arms SET owner = ? WHERE id = ?",
        JSON.stringify([{ pid: proc.pid, start: "different start identity" }]),
        row.id,
      );
      expect(metrics().watchers).toMatchObject({ ownerLost: 1, dead: 0, stale: 1 });
      s.sqlWrite("UPDATE wait_arms SET process = NULL, owner = NULL, scope = NULL WHERE id = ?", row.id);
      expect(metrics().watchers).toMatchObject({ unverified: 1, dead: 0, expired: 1, stale: 1 });
      s.sqlWrite("UPDATE wait_arms SET process = ?, owner = ? WHERE id = ?", row.process, row.owner, row.id);
      proc.kill("SIGKILL");
      await proc.exited;
      expect(metrics().watchers).toMatchObject({ dead: 1, expired: 1, stale: 1 });
      expect(s.sql("SELECT ended_at FROM wait_arms WHERE id = ?", row.id)[0].ended_at).toBeNull();
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("failed process check is unverified, never dead; naturally timed-out waits are ended", async () => {
    const { proc } = await arm();
    try {
      const stub = join(s.dir, "stub");
      mkdirSync(stub);
      writeFileSync(join(stub, "ps"), "#!/bin/sh\nexit 2\n", { mode: 0o700 });
      const before = dbBytes();
      const m = s.ok(["metrics"], { as: parent, env: { PATH: `${stub}:${process.env.PATH}` } });
      expect(m.watchers).toMatchObject({ unverified: 1, dead: 0, live: 0, stale: 0 });
      expect(dbBytes()).toEqual(before);
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    const r = s.run(["wait", "--replace", "--timeout", "10ms"], { as: parent });
    expect(r.code).toBe(3);
    expect(metrics().watchers).toMatchObject({ ended: 2, unended: 0, dead: 0, stale: 0 });
  });
});
