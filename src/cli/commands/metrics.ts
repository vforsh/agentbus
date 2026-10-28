import type { Command } from "commander";
import { requireCaller } from "../../services/caller.ts";
import { collectMetrics, type Metrics } from "../../services/metrics.ts";
import { type MetricsOptions, metricsFilter } from "../../services/metrics-filter.ts";
import { openStore } from "../../store/db.ts";
import { action } from "../action.ts";
import { collect } from "../context.ts";

const LATENCY_INTERVALS = [
  "commitToSeen",
  "seenToAck",
  "commitToAck",
  "commitToDelivery",
  "deliveryToAck",
] as const;

function backlogRows(m: Metrics) {
  return [
    { key: "questions", label: "questions", backlog: m.questions },
    { key: "followups", label: "followups", backlog: m.followups },
    { key: "awaitingSeen", label: "results awaiting seen", backlog: m.results.awaitingSeen },
    { key: "awaitingAck", label: "results awaiting ack", backlog: m.results.awaitingAck },
  ];
}

export function registerMetrics(program: Command): void {
  program
    .command("metrics")
    .description("Read-only delivery latency, pending backlog age and local watcher evidence")
    .option("--global", "all retained delegations and waits; needs no caller identity")
    .option("--since <date|duration>", "delegations opened at/after this ISO date/time or lookback, e.g. 14d")
    .option("--until <date>", "delegations opened before this ISO date/time (exclusive)")
    .option("--project <dir>", "worker checkout or parent directory; includes descendant directories")
    .option("--direction <parent:worker>", "provider direction, e.g. claude:codex")
    .option("--model <model>", "worker model label")
    .option("--label <k=v>", "worker label filter (repeatable, combined with AND)", collect, [])
    .option("--group-by <field>", "project, direction, model or label:<key>")
    .action(
      action((ctx, opts: MetricsOptions & { global?: boolean }) => {
        const filter = metricsFilter(opts);
        const db = openStore(ctx.paths, { readonly: true });
        try {
          const parentId = opts.global ? null : requireCaller(db, ctx.opts.as).session.id;
          const metrics = collectMetrics(db, parentId, filter);
          ctx.emit(
            metrics,
            () => human(metrics),
            () => plain(metrics),
          );
        } finally {
          db.close();
        }
      }),
    );
}

function plain(m: Metrics): string[] {
  const lines = [
    `snapshot\t${m.snapshotAt}\tms\t${m.scope.kind}\t${m.scope.parentId ?? "-"}`,
    `metricsVersion\t${m.metricsVersion}`,
    `delegations\t${m.delegations.total}\t${m.delegations.withoutResult}`,
  ];
  const intervals = [
    ...LATENCY_INTERVALS.map((key) => [key, m.results[key]] as const),
    ["duration", m.delegations.duration],
    ["questionResponse", m.questionResponse.latency],
  ] as const;
  for (const [key, d] of intervals) {
    lines.push(
      [
        "latency",
        key,
        d.measured,
        d.pending,
        d.missing,
        d.settled,
        d.invalid,
        d.minMs ?? "-",
        d.meanMs ?? "-",
        d.maxMs ?? "-",
        d.p50Ms ?? "-",
        d.p90Ms ?? "-",
        d.p95Ms ?? "-",
        d.unobserved,
      ].join("\t"),
    );
  }
  lines.push(["filters", JSON.stringify(m.filters)].join("\t"));
  for (const [source, n] of Object.entries(m.results.seenSources)) lines.push(`seenSource\t${source}\t${n}`);
  lines.push(
    [
      "questionResponse",
      m.questionResponse.count,
      m.questionResponse.answered,
      m.questionResponse.closedUnanswered,
    ].join("\t"),
  );
  for (const group of m.groups)
    lines.push(["group", m.filters.groupBy, JSON.stringify(group.value), JSON.stringify(group)].join("\t"));
  for (const { key, backlog: b } of backlogRows(m))
    lines.push(
      ["backlog", key, b.count, b.unseen, b.oldest?.messageId ?? "-", b.oldest?.ageMs ?? "-"].join("\t"),
    );
  const w = m.watchers;
  lines.push(
    [
      "watchers",
      w.total,
      w.ended,
      w.unended,
      w.live,
      w.dead,
      w.ownerLost,
      w.unverified,
      w.expired,
      w.stale,
    ].join("\t"),
  );
  return lines;
}

function human(m: Metrics): string {
  const lines = [
    `Metrics ${m.scope.kind}${m.scope.parentId ? ` ${m.scope.parentId}` : ""} at ${m.snapshotAt} (ms)`,
  ];
  lines.push(
    `cohort: opened [${m.filters.since ?? "-infinity"}, ${m.filters.until ?? "+infinity"}); project ${m.filters.project ?? "all"}; direction ${m.filters.direction ?? "all"}; labels ${JSON.stringify(m.filters.labels)}`,
  );
  lines.push(
    `delegations: ${m.delegations.total} retained, ${m.delegations.withoutResult} without result; ${m.results.count} results`,
  );
  for (const key of LATENCY_INTERVALS) {
    const d = m.results[key];
    lines.push(
      `${key}: ${d.measured} measured; min/mean/max ${d.minMs ?? "-"}/${d.meanMs ?? "-"}/${d.maxMs ?? "-"} ms; p50/p90/p95 ${d.p50Ms ?? "-"}/${d.p90Ms ?? "-"}/${d.p95Ms ?? "-"}; ${d.pending} pending, ${d.missing} missing, ${d.settled} settled, ${d.invalid} invalid, ${d.unobserved} unobserved`,
    );
  }
  const duration = m.delegations.duration;
  lines.push(
    `duration: ${duration.measured} completed; p50/p90/p95 ${duration.p50Ms ?? "-"}/${duration.p90Ms ?? "-"}/${duration.p95Ms ?? "-"} ms; ${duration.pending} open`,
  );
  const q = m.questionResponse;
  lines.push(
    `questionResponse: ${q.answered}/${q.count} answered, ${q.closedUnanswered} closed unanswered; p50/p90/p95 ${q.latency.p50Ms ?? "-"}/${q.latency.p90Ms ?? "-"}/${q.latency.p95Ms ?? "-"} ms`,
  );
  lines.push(
    `seen sources: ${Object.entries(m.results.seenSources)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
  lines.push(
    "Delivery intervals exclude ack-inferred and legacy seen timestamps; ordinary read records no delivery.",
  );
  for (const g of m.groups)
    lines.push(
      `${m.filters.groupBy}=${g.value ?? "(unlabelled)"}: ${g.delegations.total} delegations, ${g.results.count} results; duration p50 ${g.delegations.duration.p50Ms ?? "-"} ms, result→ack p50/p95 ${g.results.commitToAck.p50Ms ?? "-"}/${g.results.commitToAck.p95Ms ?? "-"} ms; questions ${g.questionResponse.answered}/${g.questionResponse.count} answered`,
    );
  for (const { label, backlog: b } of backlogRows(m))
    lines.push(
      `${label}: ${b.count} pending (${b.unseen} unseen); oldest ${b.oldest ? `${b.oldest.messageId}, ${b.oldest.ageMs} ms` : "-"}`,
    );
  const w = m.watchers;
  lines.push(
    `watchers: ${w.unended} unended, ${w.ended} ended; ${w.live} live, ${w.dead} dead, ${w.ownerLost} owner lost, ${w.unverified} unverified; ${w.expired} expired, ${w.stale} stale (overlapping)`,
  );
  return lines.join("\n");
}
