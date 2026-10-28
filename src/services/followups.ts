// Follow-up delivery to a running worker: parent mail the worker has not been shown yet. A worker only
// waits for mail after asking a question, so anything the parent sends mid-task needs another path; for
// Claude workers that path is the doorbell hook (adapters/claude/doorbell.ts).

import { type Db, tx } from "../store/db.ts";
import { type MessageRow, markSeen } from "../store/messages.ts";

/**
 * Unseen, unacknowledged mail from the parent of the session's open delegation. Requests are excluded (the
 * launch prompt delivers them), and so is everything else in the inbox: a worker that also leads children
 * keeps their results for its own wait.
 */
const PENDING = `FROM sessions s
  JOIN delegations d ON d.worker_id = s.id AND d.state = 'open'
  JOIN messages m ON m.to_id = s.id AND m.from_id = d.parent_id AND m.type <> 'request'
  JOIN receipts r ON r.message_id = m.id AND r.seen_at IS NULL AND r.acknowledged_at IS NULL
  WHERE s.provider = $provider AND s.external_id = $native`;

const MAX_ANNOUNCED = 20;

export interface FollowUps {
  workerId: string;
  parentId: string;
  requestId: string;
  messages: MessageRow[];
}

/** Cheap read-only probe, safe to run on every tool call. */
export function hasFollowUps(db: Db, provider: string, nativeId: string): boolean {
  return (
    db.query<{ one: number }, [Record<string, string>]>(`SELECT 1 AS one ${PENDING} LIMIT 1`).get({
      provider,
      native: nativeId,
    }) !== null
  );
}

/**
 * Claims pending follow-ups by marking them seen, in one transaction, so a concurrent `wait` and repeated
 * hooks partition them instead of announcing twice. Acknowledgement stays with the worker.
 */
export function claimFollowUps(db: Db, provider: string, nativeId: string): FollowUps | null {
  return tx(db, () => {
    const rows = db
      .query<
        MessageRow & { worker_id: string; parent_id: string; request_id: string },
        [Record<string, string | number>]
      >(
        `SELECT m.*, r.seen_at, r.seen_source, r.acknowledged_at, r.settled_reason,
                  s.id AS worker_id, d.parent_id, d.request_id
           ${PENDING} ORDER BY m.sequence LIMIT $limit`,
      )
      .all({ provider, native: nativeId, limit: MAX_ANNOUNCED });
    if (rows.length === 0) return null;
    markSeen(
      db,
      rows.map((r) => r.id),
      "doorbell",
    );
    const { worker_id, parent_id, request_id } = rows[0]!;
    return { workerId: worker_id, parentId: parent_id, requestId: request_id, messages: rows };
  });
}

/**
 * Parent mail a worker must handle within its delegation: every parent-to-worker message of the
 * delegation's correlation except the request itself (follow-ups and answers to questions), with receipts.
 * Handled means acknowledged by the worker; seen alone is not handled.
 */
export function parentMail(db: Db, d: { request_id: string; parent_id: string; worker_id: string }) {
  return db
    .query<MessageRow, [Record<string, string>]>(
      `SELECT m.*, r.seen_at, r.seen_source, r.acknowledged_at, r.settled_reason
         FROM messages m JOIN receipts r ON r.message_id = m.id
        WHERE m.correlation_id = $request AND m.from_id = $parent AND m.to_id = $worker AND m.type <> 'request'
        ORDER BY m.sequence`,
    )
    .all({ request: d.request_id, parent: d.parent_id, worker: d.worker_id });
}

export interface FollowUpCounts {
  total: number;
  /** Not acknowledged by the worker yet; blocks a success result. */
  pending: number;
  /** Pending and never shown to the worker (no wait, read-and-ack or doorbell delivered it). */
  unseen: number;
  /** Settled by the delegation's end without the worker acknowledging them. */
  unhandled: number;
  pendingIds: string[];
  unhandledIds: string[];
}

export function followUpCounts(rows: MessageRow[]): FollowUpCounts {
  const pending = rows.filter((m) => !m.acknowledged_at);
  const unhandled = rows.filter((m) => m.settled_reason);
  return {
    total: rows.length,
    pending: pending.length,
    unseen: pending.filter((m) => !m.seen_at).length,
    unhandled: unhandled.length,
    pendingIds: pending.map((m) => m.id),
    unhandledIds: unhandled.map((m) => m.id),
  };
}
