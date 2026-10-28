import { failure } from "../errors.ts";
import {
  BATCH_BODY_BUDGET,
  ENVELOPE_VERSION,
  type Envelope,
  type MessageType,
  type NoticeMeta,
  type Outcome,
  type SeenSource,
  type SettledReason,
} from "../protocol/types.ts";
import { newId, nowIso } from "../util/misc.ts";
import type { Db } from "./db.ts";

export interface MessageRow {
  sequence: number;
  id: string;
  schema_version: number;
  from_id: string;
  to_id: string;
  type: MessageType;
  summary: string | null;
  body: string;
  created_at: string;
  correlation_id: string;
  in_reply_to: string | null;
  idempotency_key: string | null;
  intent_hash: string | null;
  outcome: Outcome | null;
  notice: string | null;
  turn_ref: string | null;
  seen_at?: string | null;
  seen_source?: SeenSource | null;
  acknowledged_at?: string | null;
  settled_reason?: SettledReason | null;
}

export function toEnvelope(row: MessageRow): Envelope {
  if (!Number.isSafeInteger(row.sequence)) {
    throw failure(
      "sequence_overflow",
      `Message sequence ${row.sequence} exceeds the JSON safe integer range`,
    );
  }
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    sequence: row.sequence,
    from: row.from_id,
    to: row.to_id,
    type: row.type,
    summary: row.summary,
    body: row.body,
    createdAt: row.created_at,
    correlationId: row.correlation_id,
    inReplyTo: row.in_reply_to,
    idempotencyKey: row.idempotency_key,
    outcome: row.outcome,
    notice: row.notice ? (JSON.parse(row.notice) as NoticeMeta) : null,
    turnRef: row.turn_ref,
    seenAt: row.seen_at ?? null,
    seenSource: row.seen_source ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
    settledReason: row.settled_reason ?? null,
  };
}

const SELECT_WITH_RECEIPT = `SELECT m.*, r.seen_at, r.seen_source, r.acknowledged_at, r.settled_reason FROM messages m JOIN receipts r ON r.message_id = m.id`;

export function getMessage(db: Db, id: string): MessageRow | null {
  return db.query<MessageRow, [string]>(`${SELECT_WITH_RECEIPT} WHERE m.id = ?`).get(id);
}

export function getByKey(db: Db, fromId: string, key: string): MessageRow | null {
  return db
    .query<MessageRow, [string, string]>(
      `${SELECT_WITH_RECEIPT} WHERE m.from_id = ? AND m.idempotency_key = ?`,
    )
    .get(fromId, key);
}

export interface InsertMessage {
  id?: string;
  fromId: string;
  toId: string;
  type: MessageType;
  summary: string | null;
  body: string;
  correlationId: string | null;
  inReplyTo: string | null;
  idempotencyKey: string | null;
  intentHash: string | null;
  outcome: Outcome | null;
  notice: NoticeMeta | null;
  turnRef: string | null;
}

/** Inserts an immutable message and its receipt row; callers run this inside their transaction. */
export function insertMessage(db: Db, m: InsertMessage): MessageRow {
  const id = m.id ?? newId();
  const now = nowIso();
  db.query(
    `INSERT INTO messages (id, schema_version, from_id, to_id, type, summary, body, created_at, correlation_id,
       in_reply_to, idempotency_key, intent_hash, outcome, notice, turn_ref)
     VALUES ($id, $v, $from, $to, $type, $summary, $body, $now, $corr, $irt, $key, $hash, $outcome, $notice, $turn)`,
  ).run({
    id,
    v: ENVELOPE_VERSION,
    from: m.fromId,
    to: m.toId,
    type: m.type,
    summary: m.summary,
    body: m.body,
    now,
    corr: m.correlationId ?? id,
    irt: m.inReplyTo,
    key: m.idempotencyKey,
    hash: m.intentHash,
    outcome: m.outcome,
    notice: m.notice ? JSON.stringify(m.notice) : null,
    turn: m.turnRef,
  });
  const seq = db
    .query<{ sequence: number }, [string]>("SELECT sequence FROM messages WHERE id = ?")
    .get(id)!.sequence;
  db.query("INSERT INTO receipts (message_id, recipient_id, sequence) VALUES (?, ?, ?)").run(id, m.toId, seq);
  return getMessage(db, id)!;
}

export interface InboxFilter {
  recipientId: string;
  includeAcknowledged: boolean;
  unseenOnly: boolean;
  after: number | null;
  fromId: string | null;
  type: MessageType | null;
  correlationIds: string[] | null;
  limit: number;
}

export interface Batch {
  rows: MessageRow[];
  hasMore: boolean;
}

/** Inbox scan in ascending sequence, bounded by count and aggregate body bytes; never truncates bodies. */
export function selectInbox(db: Db, f: InboxFilter): Batch {
  const where: string[] = ["r.recipient_id = $recipient"];
  const params: Record<string, string | number> = { recipient: f.recipientId };
  if (!f.includeAcknowledged) where.push("r.acknowledged_at IS NULL");
  if (f.unseenOnly) where.push("r.seen_at IS NULL");
  if (f.after !== null) {
    where.push("r.sequence > $after");
    params.after = f.after;
  }
  if (f.fromId) {
    where.push("m.from_id = $from");
    params.from = f.fromId;
  }
  if (f.type) {
    where.push("m.type = $type");
    params.type = f.type;
  }
  if (f.correlationIds) {
    if (f.correlationIds.length === 0) return { rows: [], hasMore: false };
    const names = f.correlationIds.map((c, i) => {
      params[`c${i}`] = c;
      return `$c${i}`;
    });
    where.push(`m.correlation_id IN (${names.join(", ")})`);
  }
  params.lim = f.limit + 1;
  const all = db
    .query<MessageRow, [Record<string, string | number>]>(
      `${SELECT_WITH_RECEIPT} WHERE ${where.join(" AND ")} ORDER BY r.sequence LIMIT $lim`,
    )
    .all(params);
  return budget(all, f.limit);
}

/** Applies the count limit and the 4 MiB body budget; always returns at least one record when available. */
export function budget(all: MessageRow[], limit: number): Batch {
  const rows: MessageRow[] = [];
  let bytes = 0;
  for (const row of all) {
    if (rows.length >= limit) return { rows, hasMore: true };
    const size = Buffer.byteLength(row.body, "utf8");
    if (rows.length > 0 && bytes + size > BATCH_BODY_BUDGET) return { rows, hasMore: true };
    rows.push(row);
    bytes += size;
  }
  return { rows, hasMore: false };
}

export function markSeen(db: Db, ids: string[], source: "wait" | "doorbell" | "read" = "wait"): string {
  const now = nowIso();
  const stmt = db.query(
    "UPDATE receipts SET seen_at = ?, seen_source = ? WHERE message_id = ? AND seen_at IS NULL",
  );
  for (const id of ids) stmt.run(now, source, id);
  return now;
}

export function acknowledge(db: Db, ids: string[]): { newlyAcknowledged: string[] } {
  const now = nowIso();
  const newly: string[] = [];
  const stmt = db.query(
    `UPDATE receipts SET acknowledged_at = ?,
       seen_source = CASE WHEN seen_at IS NULL THEN 'ack' ELSE seen_source END,
       seen_at = coalesce(seen_at, ?) WHERE message_id = ? AND acknowledged_at IS NULL`,
  );
  for (const id of ids) {
    const res = stmt.run(now, now, id);
    if (res.changes > 0) newly.push(id);
  }
  return { newlyAcknowledged: newly };
}

export function messagesInCorrelation(db: Db, correlationId: string): MessageRow[] {
  return db
    .query<MessageRow, [string]>(`${SELECT_WITH_RECEIPT} WHERE m.correlation_id = ? ORDER BY m.sequence`)
    .all(correlationId);
}
