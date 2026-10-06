import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../harness.ts";

let s: Store;
let projectDir: string;
const LEAD = "generic:lead";
const TEN_DAYS_AGO = new Date(Date.now() - 10 * 86_400_000).toISOString();

beforeEach(() => {
  s = new Store().init();
  s.register("generic", "lead", "lead");
  projectDir = join(s.dir, "project");
  mkdirSync(projectDir);
});
afterEach(() => s.cleanup());

const delegate = (name: string, as = LEAD) =>
  s.ok(["delegate", "--to", "claude", "--cwd", projectDir, "--file", "-", "--name", name], {
    as,
    input: `Task ${name}`,
  });

/** Worker asks, parent answers, worker publishes a result; `ackResult` decides whether the parent handles it. */
function finish(d: { workerId: string; requestId: string }, parent = LEAD, ackResult = true): string {
  s.ok(["ack", d.requestId], { as: d.workerId });
  const q = s.ok(["reply", d.requestId, "--type", "question", "--file", "-"], {
    as: d.workerId,
    input: "Which?",
  });
  s.ok(["ack", q.messageId], { as: parent });
  const a = s.ok(["reply", q.messageId, "--file", "-"], { as: parent, input: "This one" });
  s.ok(["ack", a.messageId], { as: d.workerId });
  const r = s.ok(["reply", d.requestId, "--type", "result", "--outcome", "success", "--file", "-"], {
    as: d.workerId,
    input: "Done",
  });
  if (ackResult) s.ok(["ack", r.messageId], { as: parent });
  return r.messageId;
}

/** Moves a worker's delegations and all mail to or from it ten days into the past. */
function backdate(d: { workerId: string }) {
  s.sqlWrite(
    "UPDATE delegations SET closed_at = ? WHERE worker_id = ? AND state <> 'open'",
    TEN_DAYS_AGO,
    d.workerId,
  );
  s.sqlWrite(
    "UPDATE messages SET created_at = ?1 WHERE from_id = ?2 OR to_id = ?2",
    TEN_DAYS_AGO,
    d.workerId,
  );
}

const names = () => s.sql<{ name: string }>("SELECT name FROM sessions ORDER BY name").map((r) => r.name);

describe("prune", () => {
  test("removes old finished workers with their history; keeps parents, unacknowledged, open and recent work", () => {
    const old = delegate("old");
    finish(old);
    backdate(old);
    s.ok(["send", old.workerId, "--file", "-"], { as: LEAD, input: "late note" });
    const unread = delegate("unread");
    finish(unread, LEAD, false);
    backdate(unread);
    const recent = delegate("recent");
    finish(recent);
    delegate("open");

    // Mail within the window means the conversation is still going; once it is old, the note nobody will
    // read goes with its recipient, while the parent's unacknowledged result keeps "unread".
    expect(s.ok(["prune", "--dry-run"]).pruned).toEqual([]);
    backdate(old);

    const before = s.sql("SELECT count(*) AS n FROM messages")[0].n;
    const dry = s.ok(["prune", "--dry-run"]);
    expect(dry.pruned).toEqual([{ workerId: old.workerId, name: "old", requestIds: [old.requestId] }]);
    expect(dry.counts).toMatchObject({ workers: 1, delegations: 1, messages: 5, receipts: 5 });
    expect(s.sql("SELECT count(*) AS n FROM messages")[0].n).toBe(before);

    const done = s.ok(["prune"]);
    expect(done.counts).toEqual(dry.counts);
    expect(names()).toEqual(["lead", "observer", "open", "recent", "unread"]);
    expect(s.sql("SELECT count(*) AS n FROM messages")[0].n).toBe(before - 5);
    expect(s.sql("SELECT * FROM delegations WHERE request_id = ?", old.requestId)).toEqual([]);
    expect(s.sql("PRAGMA foreign_key_check")).toEqual([]);
    expect(s.sql("PRAGMA integrity_check")[0].integrity_check).toBe("ok");

    const listed = s.ok(["delegations", "--all"], { as: LEAD }).delegations.map((d: any) => d.name);
    expect(listed.sort()).toEqual(["open", "recent", "unread"]);
    expect(s.ok(["prune"]).counts.workers).toBe(0);
  });

  test("message sequences keep increasing after pruning, so cursors never revisit old numbers", () => {
    const d = delegate("seq");
    finish(d);
    backdate(d);
    const maxBefore = s.sql("SELECT max(sequence) AS m FROM messages")[0].m;
    s.ok(["prune"]);
    const next = delegate("next");
    const seq = s.sql("SELECT sequence FROM messages WHERE id = ?", next.requestId)[0].sequence;
    expect(seq).toBeGreaterThan(maxBefore);
  });

  test("a worker leading its own children goes only together with them", () => {
    const lead = delegate("nested-lead");
    s.ok(["ack", lead.requestId], { as: lead.workerId });
    const child = delegate("nested-child", lead.workerId);
    const childResult = finish(child, lead.workerId);
    expect(childResult).toBeTruthy();
    const r = s.ok(["reply", lead.requestId, "--type", "result", "--outcome", "success", "--file", "-"], {
      as: lead.workerId,
      input: "Children done",
    });
    s.ok(["ack", r.messageId], { as: LEAD });
    backdate(lead);

    // The child finished recently, so the lead stays with it.
    expect(s.ok(["prune"]).counts.workers).toBe(0);
    backdate(child);
    const out = s.ok(["prune"]);
    expect(out.pruned.map((w: any) => w.name).sort()).toEqual(["nested-child", "nested-lead"]);
    expect(names()).toEqual(["lead", "observer"]);
    expect(s.sql("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("sessions registered by hand are never pruned, even after working on a request", () => {
    const peer = s.register("generic", "peer", "peer");
    const req = s.ok(["send", "generic:peer", "--type", "request", "--file", "-"], {
      as: LEAD,
      input: "Look",
    });
    s.ok(["ack", req.messageId], { as: peer });
    const r = s.ok(["reply", req.messageId, "--type", "result", "--outcome", "success", "--file", "-"], {
      as: peer,
      input: "Looked",
    });
    s.ok(["ack", r.messageId], { as: LEAD });
    backdate({ workerId: peer });
    expect(s.ok(["prune"]).counts.workers).toBe(0);
    expect(s.ok(["whoami"], { as: "generic:peer" }).registered).toBe(true);
  });

  test("a recent or possibly running wait keeps the worker; an old abandoned arm does not", () => {
    const d = delegate("waiter");
    finish(d);
    backdate(d);
    const arm = (created: string, ended: string | null) =>
      s.sqlWrite(
        "INSERT INTO wait_arms (id, session_id, created_at, ended_at) VALUES (?, ?, ?, ?)",
        crypto.randomUUID(),
        d.workerId,
        created,
        ended ?? (null as unknown as string),
      );
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    arm(hoursAgo(2), null);
    expect(s.ok(["prune", "--older-than", "1h", "--dry-run"]).pruned).toEqual([]);
    s.sqlWrite("DELETE FROM wait_arms");
    // Killed with SIGKILL long ago: never ended, but older than the longest possible wait.
    arm(TEN_DAYS_AGO, null);
    expect(s.ok(["prune"]).counts).toMatchObject({ workers: 1, waitArms: 1 });
  });

  test("--older-than takes day units and rejects bad durations", () => {
    expect(s.ok(["prune", "--older-than", "30d", "--dry-run"]).dryRun).toBe(true);
    expect(s.run(["prune", "--older-than", "7 days"]).code).toBe(2);
  });
});
