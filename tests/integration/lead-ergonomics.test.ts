import { afterAll, describe, expect, test } from "bun:test";
import { Store, uuid } from "../harness.ts";

const stores: Store[] = [];
function inbox() {
  const s = new Store().init();
  stores.push(s);
  const sender = s.register("generic", "sender");
  const recipient = s.register("generic", "recipient");
  const other = s.register("generic", "other");
  const send = (body: string, to = recipient) =>
    s.ok(["send", to, "--file", "-"], { as: sender, input: body }).messageId as string;
  return { s, sender, recipient, other, send };
}
afterAll(() => {
  for (const s of stores) s.cleanup();
});

describe("lead message ergonomics", () => {
  test("show prints a full readable body for either participant without consuming it", () => {
    const { s, sender, recipient, other, send } = inbox();
    const body = `Line one\n"quotes", \\paths, Привет 🚀\n${"result detail\n".repeat(3000)}`;
    const id = send(body);
    for (const as of [sender, recipient]) {
      const shown = s.run(["show", id], { as, json: false });
      expect(shown.code).toBe(0);
      expect(shown.stdout).toBe(body);
      expect(s.ok(["show", id], { as }).message.body).toBe(body);
    }
    expect(s.run(["show", id], { as: other }).json?.error.code).toBe("not_participant");
    expect(s.run(["show", uuid()], { as: recipient }).json?.error.code).toBe("message_not_found");
    expect(s.ok(["read", "--unseen"], { as: recipient }).messages[0].id).toBe(id);
    s.ok(["ack", id], { as: recipient });
    expect(s.ok(["show", id], { as: recipient }).message.acknowledgedAt).not.toBeNull();
  });

  test("reply acks atomically; opt-out and keyed retry keep one answer", () => {
    const { s, recipient, send } = inbox();
    const id = send("Question?");
    const args = ["reply", id, "--key", "answer", "--file", "-"];
    const first = s.ok([...args, "--no-ack"], { as: recipient, input: "Answer." });
    expect(first.acknowledged).toEqual([]);
    expect(s.ok(["read"], { as: recipient }).messages.map((m: any) => m.id)).toEqual([id]);
    const conflict = s.run(args, { as: recipient, input: "Different answer." });
    expect(conflict.json?.error.code).toBe("idempotency_conflict");
    expect(s.ok(["show", id], { as: recipient }).message.acknowledgedAt).toBeNull();
    const retry = s.ok(args, { as: recipient, input: "Answer." });
    expect(retry).toMatchObject({ duplicate: true, messageId: first.messageId, acknowledged: [id] });
    expect(s.ok(["read", "--unseen"], { as: recipient }).messages).toEqual([]);
    expect(s.ok(args, { as: recipient, input: "Answer." }).messageId).toBe(first.messageId);

    const next = send("Another question?");
    expect(s.ok(["reply", next, "--file", "-"], { as: recipient, input: "Yes." }).acknowledged).toEqual([
      next,
    ]);
  });

  test("failed or dry-run replies never acknowledge their source", () => {
    const { s, recipient, other, send } = inbox();
    const id = send("Still pending");
    expect(
      s.run(["reply", id, "--type", "question", "--file", "-"], { as: recipient, input: "x" }).code,
    ).toBe(2);
    expect(s.run(["reply", id, "--file", "-"], { as: other, input: "x" }).code).toBe(5);
    s.ok(["reply", id, "--dry-run", "--file", "-"], { as: recipient, input: "x" });
    expect(s.ok(["show", id], { as: recipient }).message.acknowledgedAt).toBeNull();
  });

  test("reply acknowledgement cannot bypass the success gate for an unhandled follow-up", () => {
    const { s, sender } = inbox();
    const d = s.ok(["delegate", "--to", "codex", "--file", "-"], { as: sender, input: "Task" });
    s.ok(["ack", d.requestId], { as: d.workerId });
    const f = s.ok(["followup", d.requestId, "--file", "-"], { as: sender, input: "Handle this too" });
    const args = ["reply", f.messageId, "--type", "result", "--outcome", "success", "--file", "-"];
    expect(s.run(args, { as: d.workerId, input: "Done" }).json?.error.code).toBe("followups_pending");
    expect(s.ok(["show", f.messageId], { as: d.workerId }).message.acknowledgedAt).toBeNull();
    s.ok(["ack", f.messageId], { as: d.workerId });
    expect(s.ok(args, { as: d.workerId, input: "Done" }).delegation.state).toBe("done");
  });

  test("read --ack accepts only its filtered page, including seen mail, with recoverable pagination", () => {
    const { s, sender, recipient, other, send } = inbox();
    const ids = [send("first"), send("second"), send("third")];
    const elsewhere = send("other inbox", other);
    s.ok(["wait", "--limit", "1", "--timeout", "1s"], { as: recipient });
    const page = s.ok(["read", "--ack", "--from", sender, "--limit", "2"], { as: recipient });
    expect(page.acknowledged).toEqual(ids.slice(0, 2));
    expect(page.hasMore).toBe(true);
    for (const m of page.messages) {
      expect(m.acknowledgedAt).not.toBeNull();
      expect(m.seenAt).not.toBeNull();
    }
    const next = s.ok(["read", "--ack", "--after", String(page.cursor)], { as: recipient });
    expect(next.acknowledged).toEqual(ids.slice(2));
    expect(next.hasMore).toBe(false);
    expect(s.ok(["read", "--ack"], { as: recipient }).acknowledged).toEqual([]);
    expect(s.ok(["show", elsewhere], { as: other }).message.acknowledgedAt).toBeNull();
    expect(s.ok(["read", "--all", "--ack"], { as: recipient }).messages).toHaveLength(3);
  });
});
