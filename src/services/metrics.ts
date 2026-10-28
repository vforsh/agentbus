import type { SeenSource } from "../protocol/types.ts";
import type { Db } from "../store/db.ts";
import type { DelegationRow } from "../store/delegations.ts";
import type { WaitArmRow } from "../store/observations.ts";
import { absent, distribution, type Interval, interval } from "./metrics-distribution.ts";
import { type MetricsFilter, metricsFilter, metricsSelection } from "./metrics-filter.ts";
import { watcherMetrics } from "./metrics-watchers.ts";

interface CohortRow extends DelegationRow {
  project: string | null;
  direction: string;
  labels: string;
}

interface MailPoint {
  id: string;
  request_id: string;
  parent_id: string;
  worker_id: string;
  type: string;
  from_id: string;
  created_at: string | null;
  seen_at: string | null;
  seen_source: SeenSource | null;
  acknowledged_at: string | null;
  settled_reason: string | null;
  receipt_id: string | null;
  answer_at: string | null;
  delegation_state: DelegationRow["state"];
}

/** Legacy seen timestamps and ack-inferred seen are not evidence of an independent delivery event. */
function receiptInterval(
  row: MailPoint,
  start: string | null,
  end: string | null,
  delivery = false,
): Interval {
  if (row.settled_reason) return absent("settled");
  if (!row.receipt_id) return absent("missing");
  if (delivery && row.seen_at && !["wait", "doorbell", "read"].includes(row.seen_source ?? ""))
    return absent("unobserved");
  if (!row.seen_at && !row.acknowledged_at && !end) return absent("pending");
  return interval(start, end);
}

function backlog(rows: MailPoint[], now: number) {
  const oldest = [...rows].sort(
    (a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id),
  )[0];
  const created = oldest?.created_at ? Date.parse(oldest.created_at) : NaN;
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
          ageMs: Number.isFinite(created) ? Math.max(0, now - created) : null,
        }
      : null,
  };
}

function summarize(cohort: CohortRow[], mail: MailPoint[], now: number) {
  const results = mail.filter((r) => r.type === "result");
  const questions = mail.filter((r) => r.type === "question" && r.from_id === r.worker_id);
  const followups = mail.filter((r) => r.from_id === r.parent_id);
  const seenSources = {
    wait: 0,
    doorbell: 0,
    read: 0,
    ack: 0,
    settlement: 0,
    legacy: 0,
    unseen: 0,
    missing: 0,
  };
  for (const row of results) {
    let source: keyof typeof seenSources;
    if (!row.receipt_id) source = "missing";
    else if (!row.seen_at) source = "unseen";
    else source = row.seen_source ?? "legacy";
    seenSources[source]++;
  }
  return {
    delegations: {
      total: cohort.length,
      withoutResult: cohort.filter((d) => !d.result_id).length,
      duration: distribution(cohort.map((d) => interval(d.opened_at, d.closed_at))),
    },
    results: {
      count: results.length,
      commitToSeen: distribution(results.map((r) => receiptInterval(r, r.created_at, r.seen_at))),
      seenToAck: distribution(results.map((r) => receiptInterval(r, r.seen_at, r.acknowledged_at))),
      commitToAck: distribution(results.map((r) => receiptInterval(r, r.created_at, r.acknowledged_at))),
      commitToDelivery: distribution(results.map((r) => receiptInterval(r, r.created_at, r.seen_at, true))),
      deliveryToAck: distribution(results.map((r) => receiptInterval(r, r.seen_at, r.acknowledged_at, true))),
      seenSources,
      awaitingSeen: backlog(
        results.filter((r) => r.receipt_id && !r.seen_at),
        now,
      ),
      awaitingAck: backlog(
        results.filter((r) => r.receipt_id && !r.acknowledged_at),
        now,
      ),
    },
    questions: backlog(
      questions.filter((r) => r.delegation_state === "open" && !r.answer_at),
      now,
    ),
    questionResponse: {
      count: questions.length,
      answered: questions.filter((r) => r.answer_at).length,
      closedUnanswered: questions.filter((r) => !r.answer_at && r.delegation_state !== "open").length,
      latency: distribution(
        questions.map((r) =>
          !r.answer_at && r.delegation_state !== "open"
            ? absent("settled")
            : interval(r.created_at, r.answer_at),
        ),
      ),
    },
    followups: backlog(
      followups.filter((r) => r.delegation_state === "open" && !r.acknowledged_at),
      now,
    ),
  };
}

function groupValue(d: CohortRow, by: string): string | null {
  if (by === "project") return d.project;
  if (by === "direction") return d.direction;
  const labels = JSON.parse(d.labels) as Record<string, string>;
  return labels[by === "model" ? "model" : by.slice("label:".length)] ?? null;
}

/** One deferred read transaction gives a consistent cohort and mailbox snapshot; no drain, probes or writes. */
export function collectMetrics(db: Db, parentId: string | null, filter: MetricsFilter = metricsFilter({})) {
  const { cte, params, filtered } = metricsSelection(parentId, filter);
  const snapshot = db
    .transaction(() => {
      const at = new Date().toISOString();
      const cohort = db
        .query<CohortRow, [typeof params]>(`${cte} SELECT * FROM selected ORDER BY opened_at, request_id`)
        .all(params);
      const mail = db
        .query<MailPoint, [typeof params]>(`${cte}
      SELECT m.id, d.request_id, d.parent_id, d.worker_id, m.type, m.from_id, m.created_at,
        d.state AS delegation_state, r.message_id AS receipt_id, r.seen_at, r.seen_source,
        r.acknowledged_at, r.settled_reason,
        CASE WHEN m.type = 'question' THEN (
          SELECT min(answer.created_at) FROM messages answer
          WHERE answer.in_reply_to = m.id AND answer.correlation_id = d.request_id
            AND answer.from_id = d.parent_id AND answer.to_id = d.worker_id
        ) END AS answer_at
      FROM selected d JOIN messages m ON m.correlation_id = d.request_id
      LEFT JOIN receipts r ON r.message_id = m.id
      WHERE m.id = d.result_id OR (m.type = 'question' AND m.from_id = d.worker_id)
        OR (m.from_id = d.parent_id AND m.to_id = d.worker_id AND m.type <> 'request')
      ORDER BY m.sequence`)
        .all(params);
      // A broad parent wait may cover several selected delegations; EXISTS counts it once. Filtered
      // reports include arms overlapping that cohort, not every old wait ever armed by its parents.
      let waitScope = `$parent IS NULL OR a.session_id = $parent
        OR EXISTS (SELECT 1 FROM selected d WHERE d.worker_id = a.session_id)`;
      if (filtered) {
        waitScope = `EXISTS (SELECT 1 FROM selected d
            WHERE a.session_id IN (d.parent_id, d.worker_id)
              AND (a.correlation IS NULL OR a.correlation = d.request_id)
              AND a.created_at <= coalesce(d.closed_at, '${at}')
              AND (a.ended_at IS NULL OR a.ended_at >= d.opened_at))`;
      }
      const arms = db
        .query<WaitArmRow, [typeof params]>(`${cte}
      SELECT a.* FROM wait_arms a WHERE ${waitScope}
      ORDER BY a.created_at, a.id`)
        .all(params);
      return { at, cohort, mail, arms };
    })
    .deferred();
  const { at, cohort, mail, arms } = snapshot;
  const now = Date.parse(at);
  const grouped = new Map<string | null, CohortRow[]>();
  if (filter.groupBy) {
    for (const d of cohort) {
      const key = groupValue(d, filter.groupBy);
      const group = grouped.get(key) ?? [];
      group.push(d);
      grouped.set(key, group);
    }
  }
  const groups = [...grouped]
    .sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))
    .map(([value, rows]) => {
      const ids = new Set(rows.map((d) => d.request_id));
      return {
        value,
        ...summarize(
          rows,
          mail.filter((m) => ids.has(m.request_id)),
          now,
        ),
      };
    });
  return {
    metricsVersion: 2,
    snapshotAt: at,
    units: "ms",
    scope: { kind: parentId === null ? "global" : "parent", parentId },
    filters: filter,
    ...summarize(cohort, mail, now),
    groups,
    // Process evidence is sampled after the mailbox snapshot; no provider CLI is called.
    watchers: watcherMetrics(arms, Date.now()),
  };
}

export type Metrics = ReturnType<typeof collectMetrics>;
