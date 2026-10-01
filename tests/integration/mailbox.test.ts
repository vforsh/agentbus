import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../harness.ts";

let s: Store;
let alice: string;
let bob: string;

beforeAll(() => {
  s = new Store().init();
  alice = s.register("generic", "alice", "alice");
  bob = s.register("generic", "bob", "bob");
});
afterAll(() => s.cleanup());

const send = (body: string, extra: string[] = [], as = "generic:alice", to = "generic:bob") =>
  s.ok(["send", to, "--file", "-", ...extra], { as, input: body });

describe("registration and identity", () => {
  test("register is idempotent on provider and external id", () => {
    const again = s.ok(["session", "register", "--provider", "generic", "--external-id", "alice"]);
    expect(again.sessionId).toBe(alice);
    expect(again.created).toBe(false);
  });

  test("whoami reports source and registration without requiring registration", () => {
    expect(s.ok(["whoami"], { as: "generic:alice" })).toMatchObject({
      address: "generic:alice",
      source: "flag",
      registered: true,
    });
    expect(s.ok(["whoami"], { as: "generic:nobody" })).toMatchObject({ registered: false });
    expect(s.ok(["whoami"], { env: { AGENTBUS_SESSION_ID: bob } })).toMatchObject({
      source: "env",
      registered: true,
    });
  });

  test("native detection refuses to guess between providers", () => {
    const r = s.run(["whoami"], {
      env: { CLAUDE_CODE_SESSION_ID: crypto.randomUUID(), CODEX_THREAD_ID: crypto.randomUUID() },
    });
    expect(r.code).toBe(5);
    expect(r.json?.error.code).toBe("ambiguous_identity");
  });

  test("the system observer cannot be impersonated", () => {
    const r = s.run(["send", "generic:bob", "--file", "-"], { as: "system:observer", input: "x" });
    expect(r.code).toBe(2);
  });

  test("codex and claude external ids must be full UUIDs", () => {
    const r = s.run(["session", "register", "--provider", "claude", "--external-id", "f000001d"]);
    expect(r.code).toBe(2);
  });

  test("mutations require a registered caller", () => {
    const r = s.run(["send", "generic:bob", "--file", "-"], { as: "generic:ghost", input: "x" });
    expect(r.code).toBe(4);
    expect(r.json?.error.code).toBe("caller_not_registered");
  });
});

describe("delivery state", () => {
  test("read never changes receipts; wait marks only its batch seen; ack implies seen", () => {
    const m1 = send("first").messageId;
    const before = s.ok(["read", "--unseen"], { as: "generic:bob" }).messages;
    expect(before.map((m: any) => m.id)).toContain(m1);
    expect(s.ok(["read", "--unseen"], { as: "generic:bob" }).messages.map((m: any) => m.id)).toContain(m1);

    const waited = s.ok(["wait", "--timeout", "1s"], { as: "generic:bob" });
    expect(waited.messages.map((m: any) => m.id)).toContain(m1);
    expect(waited.origin.agentbusWaitOrigin).toBe(1);
    // Seen but unacknowledged mail stays recoverable by the default read.
    expect(s.ok(["read", "--unseen"], { as: "generic:bob" }).messages).toHaveLength(0);
    const pending = s.ok(["read"], { as: "generic:bob" }).messages;
    expect(pending.find((m: any) => m.id === m1).seenAt).not.toBeNull();

    s.ok(["ack", m1], { as: "generic:bob" });
    expect(s.ok(["ack", m1], { as: "generic:bob" }).newlyAcknowledged).toHaveLength(0);
    expect(s.ok(["read"], { as: "generic:bob" }).messages.map((m: any) => m.id)).not.toContain(m1);
    expect(s.ok(["read", "--all"], { as: "generic:bob" }).messages.map((m: any) => m.id)).toContain(m1);
  });

  test("an acknowledged message never wakes a waiter", () => {
    const m = send("acked before wait").messageId;
    s.ok(["ack", m], { as: "generic:bob" });
    const r = s.run(["wait", "--timeout", "500ms"], { as: "generic:bob" });
    expect(r.code).toBe(3);
    expect(r.json?.data.timedOut).toBe(true);
    expect(r.json?.data.messages).toHaveLength(0);
  });

  test("acknowledgement is recipient-scoped and atomic", () => {
    const mine = send("for bob").messageId;
    const theirs = send("for alice", [], "generic:bob", "generic:alice").messageId;
    const r = s.run(["ack", mine, theirs], { as: "generic:bob" });
    expect(r.code).toBe(5);
    expect(s.ok(["read"], { as: "generic:bob" }).messages.map((m: any) => m.id)).toContain(mine);
    const wrongReply = s.run(["reply", theirs, "--file", "-"], { as: "generic:bob", input: "x" });
    expect(wrongReply.code).toBe(5);
    s.ok(["ack", mine], { as: "generic:bob" });
    s.ok(["ack", theirs], { as: "generic:alice" });
  });

  test("inbox reads stay caller-scoped", () => {
    const m = send("private").messageId;
    expect(s.ok(["read", "--all"], { as: "generic:alice" }).messages.map((x: any) => x.id)).not.toContain(m);
    s.ok(["ack", m], { as: "generic:bob" });
  });
});

describe("bodies and input", () => {
  test("quotes, shell syntax, Cyrillic and long text arrive unchanged through stdin and files", () => {
    const tricky = `He said "hi" & 'bye'; $(rm -rf /) \`ls\` | grep x > /dev/null\nПривет, мир! Ёжик 🚀\n${"long line ".repeat(20000)}`;
    const viaStdin = send(tricky).messageId;
    const file = join(s.dir, "body.md");
    writeFileSync(file, tricky);
    const viaFile = s.ok(["send", "generic:bob", "--file", file], { as: "generic:alice" }).messageId;
    const msgs = s.ok(["read", "--limit", "1000"], { as: "generic:bob" }).messages;
    expect(msgs.find((m: any) => m.id === viaStdin).body).toBe(tricky);
    expect(msgs.find((m: any) => m.id === viaFile).body).toBe(tricky);
    s.ok(["ack", viaStdin, viaFile], { as: "generic:bob" });
  });

  test("bodies above 1 MiB and malformed UTF-8 are rejected", () => {
    const big = s.run(["send", "generic:bob", "--file", "-"], {
      as: "generic:alice",
      input: "x".repeat(1024 * 1024 + 1),
    });
    expect(big.code).toBe(2);
    expect(big.json?.error.code).toBe("input_too_large");
    const bad = s.run(["send", "generic:bob", "--file", "-"], {
      as: "generic:alice",
      input: new Uint8Array([0xff, 0xfe, 0x41]),
    });
    expect(bad.code).toBe(2);
    expect(bad.json?.error.code).toBe("invalid_utf8");
  });

  test("summaries must be single lines of at most 200 characters", () => {
    expect(
      s.run(["send", "generic:bob", "--file", "-", "--summary", "a\nb"], { as: "generic:alice", input: "x" })
        .code,
    ).toBe(2);
    expect(
      s.run(["send", "generic:bob", "--file", "-", "--summary", "y".repeat(201)], {
        as: "generic:alice",
        input: "x",
      }).code,
    ).toBe(2);
  });
});

describe("idempotency", () => {
  test("a keyed retry returns the original message; changed intent conflicts", () => {
    const a = send("keyed", ["--key", "k1"]);
    const b = send("keyed", ["--key", "k1"]);
    expect(b.messageId).toBe(a.messageId);
    expect(b.duplicate).toBe(true);
    const c = s.run(["send", "generic:bob", "--file", "-", "--key", "k1"], {
      as: "generic:alice",
      input: "different",
    });
    expect(c.code).toBe(5);
    expect(c.json?.error.code).toBe("idempotency_conflict");
    const unkeyed1 = send("same").messageId;
    const unkeyed2 = send("same").messageId;
    expect(unkeyed1).not.toBe(unkeyed2);
    s.ok(["ack", a.messageId, unkeyed1, unkeyed2], { as: "generic:bob" });
  });
});

describe("pagination", () => {
  test("more than 50 pending messages drain fully in stable order with cursors", () => {
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push(send(`m${i}`).messageId);
    const page1 = s.ok(["read"], { as: "generic:bob" });
    expect(page1.messages).toHaveLength(50);
    expect(page1.hasMore).toBe(true);
    const seen: string[] = page1.messages.map((m: any) => m.id);
    let cursor = page1.cursor;
    for (;;) {
      const page = s.ok(["read", "--after", String(cursor)], { as: "generic:bob" });
      seen.push(...page.messages.map((m: any) => m.id));
      if (!page.hasMore) break;
      cursor = page.cursor;
    }
    expect(seen).toEqual(ids);
    // A fresh recovery sweep without a cursor still starts from the oldest pending message.
    expect(s.ok(["read", "--limit", "1"], { as: "generic:bob" }).messages[0].id).toBe(ids[0]);
    for (let i = 0; i < ids.length; i += 40) s.ok(["ack", ...ids.slice(i, i + 40)], { as: "generic:bob" });
  });

  test("byte-limited batches return hasMore instead of truncating bodies", () => {
    const body = "z".repeat(1024 * 1024 - 10);
    const ids = [1, 2, 3, 4, 5].map(() => send(body).messageId);
    const page = s.ok(["read", "--limit", "1000"], { as: "generic:bob" });
    expect(page.messages.length).toBeLessThan(5);
    expect(page.hasMore).toBe(true);
    for (const m of page.messages) expect(m.body.length).toBe(body.length);
    s.ok(["ack", ...ids], { as: "generic:bob" });
  });
});

describe("persistence", () => {
  test("committed messages survive the sender exiting and a fresh process reopening the store", () => {
    const id = send("durable").messageId;
    const integrity = s.sql<{ integrity_check: string }>("PRAGMA integrity_check")[0]!.integrity_check;
    expect(integrity).toBe("ok");
    expect(s.ok(["read"], { as: "generic:bob" }).messages.map((m: any) => m.id)).toContain(id);
    s.ok(["ack", id], { as: "generic:bob" });
  });

  test("other commands refuse a store from a newer schema", () => {
    const other = new Store().init();
    const { Database } = require("bun:sqlite");
    const db = new Database(join(other.stateDir, "agentbus.sqlite3"));
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future', 'x')");
    db.close();
    const r = other.run(["session", "list"]);
    expect(r.code).toBe(1);
    expect(r.json?.error.code).toBe("schema_mismatch");
    expect(other.run(["init"]).code).toBe(1);
    other.cleanup();
  });
});
