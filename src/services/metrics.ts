import type { Db } from "../store/db.ts";
import type { WaitArmRow } from "../store/observations.ts";
import { watcherMetrics } from "./metrics-watchers.ts";

interface MailPoint {
  id: string;
  request_id: string;
  parent_id: string;
  worker_id: string;
  created_at: string | null;
  seen_at: string | null;
  acknowledged_at: string | null;
  settled_reason: string | null;
  receipt_id: string | null;
}

type IntervalState = "measured" | "pending" | "missing" | "settled" | "invalid";
function interval(row: MailPoint, start: string | null, end: string | null) {
  if (row.settled_reason) return { state: "settled" as const, ms: null };
  if (!row.receipt_id || !start) return { state: "missing" as const, ms: null };
  if (!end) return { state: "pending" as const, ms: null };
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return { state: "invalid" as const, ms: null };
  return { state: "measured" as const, ms };
}

function distribution(points: { state: IntervalState; ms: number | null }[]) {
  const counts = { measured: 0, pending: 0, missing: 0, settled: 0, invalid: 0 };
  let min: number | null = null;
  let max: number | null = null;
  let sum = 0;
  for (const point of points) {
    counts[point.state]++;
    if (point.ms === null) continue;
    min = min === null ? point.ms : Math.min(min, point.ms);
    max = max === null ? point.ms : Math.max(max, point.ms);
    sum += point.ms;
  }
  return { ...counts, minMs: min, maxMs: max, meanMs: counts.measured ? sum / counts.measured : null };
}

function backlog(rows: MailPoint[], now: number) {
  const oldest = [...rows].sort(
    (a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id),
  )[0];
  return {
    count: rows.length,
    unseen: rows.filter((r) => !r.seen_at).length,
    oldest: oldest
      ? {
          messageId: oldest.id,
          requestId: oldest.request_id,
          parentId: oldest.parent_id,
          workerId: oldest.worker_id,
          createdAt: oldest.created_at,
          ageMs: oldest.created_at ? Math.max(0, now - Date.parse(oldest.created_at)) : null,
        }
      : null,
  };
}

const COLUMNS = `m.id, d.request_id, d.parent_id, d.worker_id, m.created_at,
  r.message_id AS receipt_id, r.seen_at, r.acknowledged_at, r.settled_reason`;

/** One deferred read transaction gives a consistent mailbox snapshot; no drain, probes or writes. */
export function collectMetrics(db: Db, parentId: string | null) {
  const snapshot = db
    .transaction(() => {
      const at = new Date().toISOString();
      const params = { parent: parentId };
      const scope = "($parent IS NULL OR d.parent_id = $parent)";
      const results = db
        .query<MailPoint, [typeof params]>(
          `SELECT ${COLUMNS} FROM delegations d JOIN messages m ON m.id = d.result_id
         LEFT JOIN receipts r ON r.message_id = m.id WHERE ${scope} ORDER BY m.sequence`,
        )
        .all(params);
      const questions = db
        .query<MailPoint, [typeof params]>(
          `SELECT ${COLUMNS} FROM delegations d JOIN messages m ON m.correlation_id = d.request_id
         LEFT JOIN receipts r ON r.message_id = m.id
         WHERE ${scope} AND d.state = 'open' AND m.type = 'question' AND m.from_id = d.worker_id
         AND NOT EXISTS (SELECT 1 FROM messages answer WHERE answer.correlation_id = d.request_id
           AND answer.from_id = d.parent_id AND answer.in_reply_to = m.id) ORDER BY m.sequence`,
        )
        .all(params);
      const followups = db
        .query<MailPoint, [typeof params]>(
          `SELECT ${COLUMNS} FROM delegations d JOIN messages m ON m.correlation_id = d.request_id
         JOIN receipts r ON r.message_id = m.id
         WHERE ${scope} AND d.state = 'open' AND m.from_id = d.parent_id AND m.to_id = d.worker_id
           AND m.type <> 'request' AND r.acknowledged_at IS NULL ORDER BY m.sequence`,
        )
        .all(params);
      const delegations = db
        .query<{ total: number; without_result: number }, [typeof params]>(
          `SELECT count(*) AS total, coalesce(sum(result_id IS NULL), 0) AS without_result
         FROM delegations d WHERE ${scope}`,
        )
        .get(params)!;
      const arms = db
        .query<WaitArmRow, [typeof params]>(
          `SELECT a.* FROM wait_arms a WHERE $parent IS NULL OR a.session_id = $parent
         OR EXISTS (SELECT 1 FROM delegations d WHERE d.parent_id = $parent AND d.worker_id = a.session_id)
         ORDER BY a.created_at, a.id`,
        )
        .all(params);
      return { at, results, questions, followups, delegations, arms };
    })
    .deferred();
  const { at, results, questions, followups, delegations, arms } = snapshot;
  const now = Date.parse(at);
  return {
    metricsVersion: 1,
    snapshotAt: at,
    units: "ms",
    scope: { kind: parentId === null ? "global" : "parent", parentId },
    delegations: { total: delegations.total, withoutResult: delegations.without_result },
    results: {
      count: results.length,
      commitToSeen: distribution(results.map((r) => interval(r, r.created_at, r.seen_at))),
      seenToAck: distribution(
        results.map((r) => {
          // Both absent is still delivery in progress, not missing historical evidence.
          if (r.receipt_id && !r.settled_reason && !r.seen_at && !r.acknowledged_at)
            return { state: "pending" as const, ms: null };
          return interval(r, r.seen_at, r.acknowledged_at);
        }),
      ),
      commitToAck: distribution(results.map((r) => interval(r, r.created_at, r.acknowledged_at))),
      awaitingSeen: backlog(
        results.filter((r) => r.receipt_id && !r.seen_at),
        now,
      ),
      awaitingAck: backlog(
        results.filter((r) => r.receipt_id && !r.acknowledged_at),
        now,
      ),
    },
    questions: backlog(questions, now),
    followups: backlog(followups, now),
    // Process evidence is sampled after the mailbox snapshot; no provider CLI is called.
    watchers: watcherMetrics(arms, Date.now()),
  };
}

export type Metrics = ReturnType<typeof collectMetrics>;
