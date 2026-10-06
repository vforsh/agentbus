import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Store, sleep } from "../harness.ts";

let s: Store;
beforeAll(() => {
  s = new Store().init();
  s.register("generic", "p", "parent");
  s.register("generic", "x", "other");
});
afterAll(() => s.cleanup());

const P = "generic:p";
const X = "generic:x";

describe("wait", () => {
  test("times out with exit 3, an empty list and timedOut", () => {
    const r = s.run(["wait", "--timeout", "300ms"], { as: P });
    expect(r.code).toBe(3);
    expect(r.json?.data).toMatchObject({ timedOut: true, messages: [], reason: "timeout" });
  });

  test("an armed wait sees a commit from another process", async () => {
    const waiter = s.runAsync(["wait", "--timeout", "10s"], { as: P });
    await sleep(600);
    const sent = s.ok(["send", P, "--file", "-"], { as: X, input: "wake up" });
    const r = await waiter;
    expect(r.code).toBe(0);
    expect(r.json?.data.messages.map((m: any) => m.id)).toEqual([sent.messageId]);
    s.ok(["ack", sent.messageId], { as: P });
  });

  test("a waiter killed after its seen commit loses no mail: recovery read finds it", () => {
    const sent = s.ok(["send", P, "--file", "-"], { as: X, input: "lost output" });
    const r = s.run(["wait", "--timeout", "2s"], {
      as: P,
      env: { AGENTBUS_FAULT_INJECT: "wait-after-seen-commit" },
    });
    expect(r.code).toBe(137);
    expect(r.stdout).toBe("");
    // Re-armed wait no longer returns it (seen), but the unconditional recovery sweep does.
    expect(s.run(["wait", "--timeout", "300ms"], { as: P }).code).toBe(3);
    const recovered = s.ok(["read"], { as: P }).messages;
    expect(recovered.map((m: any) => m.id)).toContain(sent.messageId);
    expect(recovered.find((m: any) => m.id === sent.messageId).seenAt).not.toBeNull();
    s.ok(["ack", sent.messageId], { as: P });
  });

  test("Ctrl-C exits 130 and pending messages remain retrievable", async () => {
    const proc = s.spawn(["wait", "--timeout", "30s", "--type", "request"], { as: P });
    await sleep(800);
    const sent = s.ok(["send", P, "--file", "-"], { as: X, input: "still here" });
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(130);
    expect(s.ok(["read"], { as: P }).messages.map((m: any) => m.id)).toContain(sent.messageId);
    s.ok(["ack", sent.messageId], { as: P });
  });

  test("concurrent waiters partition unseen mail instead of broadcasting", async () => {
    const ids = [1, 2, 3, 4].map(
      (i) => s.ok(["send", P, "--file", "-"], { as: X, input: `m${i}` }).messageId,
    );
    const [a, b] = await Promise.all([
      s.runAsync(["wait", "--timeout", "1s", "--limit", "2"], { as: P }),
      s.runAsync(["wait", "--timeout", "1s", "--limit", "2"], { as: P }),
    ]);
    const got = [...(a.json?.data.messages ?? []), ...(b.json?.data.messages ?? [])].map((m: any) => m.id);
    expect(new Set(got).size).toBe(got.length);
    s.ok(["ack", ...ids], { as: P });
  });

  test("--replace retires the running wait, which exits superseded without claiming mail", async () => {
    const open = () => s.sql("SELECT count(*) AS n FROM wait_arms WHERE ended_at IS NULL")[0].n as number;
    const before = open();
    const older = s.runAsync(["wait", "--timeout", "20s"], { as: P });
    for (let i = 0; i < 100 && open() === before; i++) await sleep(50);
    const newer = s.runAsync(["wait", "--replace", "--timeout", "10s"], { as: P });
    const retired = await older;
    expect(retired.code).toBe(0);
    expect(retired.json?.data).toMatchObject({ reason: "superseded", messages: [], timedOut: false });
    expect(retired.json?.data.recovery).toContain("do not re-arm");
    const sent = s.ok(["send", P, "--file", "-"], { as: X, input: "for the newer wait" });
    const r = await newer;
    expect(r.json?.data.replaced).toBeGreaterThanOrEqual(1); // also counts arms abandoned by killed waits
    expect(r.json?.data.messages.map((m: any) => m.id)).toEqual([sent.messageId]);
    s.ok(["ack", sent.messageId], { as: P });
  });

  test("--settled returns empty, attention early, then settled", async () => {
    const empty = s.ok(["wait", "--settled", "--timeout", "1s"], { as: P });
    expect(empty.reason).toBe("empty");

    const one = s.ok(["delegate", "--to", "codex", "--file", "-", "--name", "asker"], {
      as: P,
      input: "task one",
    });
    const two = s.ok(["delegate", "--to", "codex", "--file", "-", "--name", "worker"], {
      as: P,
      input: "task two",
    });
    s.ok(["reply", two.requestId, "--type", "progress", "--file", "-"], {
      as: two.workerId,
      input: "progress backlog",
    });
    const pending = s.run(["wait", "--settled", "--timeout", "500ms"], { as: P });
    expect(pending.code).toBe(3);
    expect(pending.json?.data.batch).toHaveLength(2);

    const q = s.ok(["reply", one.requestId, "--type", "question", "--summary", "?", "--file", "-"], {
      as: one.workerId,
      input: "which?",
    });
    const attention = s.ok(["wait", "--settled", "--timeout", "2s"], { as: P });
    expect(attention.reason).toBe("attention");
    expect(attention.messages[0].id).toBe(q.messageId);
    expect(attention.batch.find((b: any) => b.requestId === two.requestId).phase).not.toBe("done");

    const answer = s.ok(["reply", q.messageId, "--file", "-"], { as: P, input: "this one" });
    s.ok(["ack", answer.messageId], { as: one.workerId });
    const waiter = s.runAsync(["wait", "--settled", "--timeout", "10s"], { as: P });
    await sleep(500);
    s.ok(["reply", one.requestId, "--type", "result", "--outcome", "success", "--file", "-"], {
      as: one.workerId,
      input: "ok",
    });
    s.ok(["reply", two.requestId, "--type", "result", "--outcome", "blocked", "--file", "-"], {
      as: two.workerId,
      input: "blocked",
    });
    const settled = (await waiter).json?.data;
    expect(settled.reason).toBe("settled");
    expect(settled.messages.map((m: any) => m.type)).toContain("result");
    expect(settled.batch.map((b: any) => b.phase).sort()).toEqual(["done", "done"]);
  });

  test("--settled rejects message filters and short probe intervals", () => {
    expect(s.run(["wait", "--settled", "--type", "result"], { as: P }).code).toBe(2);
    expect(s.run(["wait", "--probe", "5s"], { as: P }).code).toBe(2);
    expect(s.run(["wait", "--timeout", "25h"], { as: P }).code).toBe(2);
  });
});
