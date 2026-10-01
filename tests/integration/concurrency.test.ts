import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Store } from "../harness.ts";

let s: Store;
beforeAll(() => {
  s = new Store().init();
  for (const n of ["a", "b", "c", "sink", "lead"]) s.register("generic", n, n);
});
afterAll(() => s.cleanup());

describe("concurrent processes", () => {
  test("concurrent writers commit every message exactly once with an intact store", async () => {
    const senders = ["a", "b", "c"];
    const perSender = 15;
    const runs = senders.flatMap((who) =>
      Array.from({ length: perSender }, (_, i) =>
        s.runAsync(["send", "generic:sink", "--file", "-", "--key", `${who}-${i}`], {
          as: `generic:${who}`,
          input: `${who}:${i}`,
        }),
      ),
    );
    // A concurrent reader must never see a partial state or fail.
    const readers = Array.from({ length: 5 }, () =>
      s.runAsync(["read", "--limit", "1000"], { as: "generic:sink" }),
    );
    const results = await Promise.all([...runs, ...readers]);
    for (const r of results) expect(r.code).toBe(0);
    const rows = s.sql<{ id: string; body: string }>(
      "SELECT id, body FROM messages WHERE to_id = (SELECT id FROM sessions WHERE external_id = 'sink')",
    );
    expect(rows).toHaveLength(senders.length * perSender);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(s.sql("PRAGMA integrity_check")[0].integrity_check).toBe("ok");
    expect(s.sql("PRAGMA foreign_key_check")).toHaveLength(0);
  });

  test("concurrent keyed delegations create one worker and one request", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        s.runAsync(["delegate", "--to", "codex", "--file", "-", "--key", "race-1", "--name", "racer"], {
          as: "generic:lead",
          input: "race",
        }),
      ),
    );
    for (const r of results) expect(r.code).toBe(0);
    const ids = new Set(results.map((r) => `${r.json?.data.workerId}/${r.json?.data.requestId}`));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.json?.data.duplicate === false)).toHaveLength(1);
    expect(s.sql("SELECT count(*) AS n FROM sessions WHERE name = 'racer'")[0].n).toBe(1);
  });

  test("a concurrent close and result choose exactly one terminal transition", async () => {
    for (let i = 0; i < 4; i++) {
      const d = s.ok(["delegate", "--to", "codex", "--file", "-"], {
        as: "generic:lead",
        input: `terminal race ${i}`,
      });
      const [close, result] = await Promise.all([
        s.runAsync(["close", d.requestId], { as: "generic:lead" }),
        s.runAsync(["reply", d.requestId, "--type", "result", "--outcome", "success", "--file", "-"], {
          as: d.workerId,
          input: "r",
        }),
      ]);
      const row = s.sql<{ state: string; result_id: string | null }>(
        "SELECT state, result_id FROM delegations WHERE request_id = ?",
        d.requestId,
      )[0]!;
      if (row.state === "done") {
        expect(result.code).toBe(0);
        expect(close.json?.data.changed).toBe(false);
      } else {
        expect(row.state).toBe("closed");
        expect(result.code).toBe(5);
        expect(
          s.sql(
            "SELECT count(*) AS n FROM messages WHERE correlation_id = ? AND type = 'result'",
            d.requestId,
          )[0].n,
        ).toBe(0);
      }
    }
  });
});
