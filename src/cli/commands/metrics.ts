import type { Command } from "commander";
import { requireCaller } from "../../services/caller.ts";
import { collectMetrics, type Metrics } from "../../services/metrics.ts";
import { openStore } from "../../store/db.ts";
import { action } from "../action.ts";

export function registerMetrics(program: Command): void {
  program
    .command("metrics")
    .description("Read-only delivery latency, pending backlog age and local watcher evidence")
    .option("--global", "all retained delegations and waits; needs no caller identity")
    .action(
      action((ctx, opts: { global?: boolean }) => {
        const db = openStore(ctx.paths, { readonly: true });
        try {
          const parentId = opts.global ? null : requireCaller(db, ctx.opts.as).session.id;
          const metrics = collectMetrics(db, parentId);
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
    `delegations\t${m.delegations.total}\t${m.delegations.withoutResult}`,
  ];
  for (const key of ["commitToSeen", "seenToAck", "commitToAck"] as const) {
    const d = m.results[key];
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
      ].join("\t"),
    );
  }
  for (const [name, b] of [
    ["questions", m.questions],
    ["followups", m.followups],
    ["awaitingSeen", m.results.awaitingSeen],
    ["awaitingAck", m.results.awaitingAck],
  ] as const)
    lines.push(
      ["backlog", name, b.count, b.unseen, b.oldest?.messageId ?? "-", b.oldest?.ageMs ?? "-"].join("\t"),
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
    `delegations: ${m.delegations.total} retained, ${m.delegations.withoutResult} without result; ${m.results.count} results`,
  );
  for (const key of ["commitToSeen", "seenToAck", "commitToAck"] as const) {
    const d = m.results[key];
    lines.push(
      `${key}: ${d.measured} measured; min/mean/max ${d.minMs ?? "-"}/${d.meanMs ?? "-"}/${d.maxMs ?? "-"} ms; ${d.pending} pending, ${d.missing} missing, ${d.settled} settled, ${d.invalid} invalid`,
    );
  }
  for (const [name, b] of [
    ["questions", m.questions],
    ["followups", m.followups],
    ["results awaiting seen", m.results.awaitingSeen],
    ["results awaiting ack", m.results.awaitingAck],
  ] as const)
    lines.push(
      `${name}: ${b.count} pending (${b.unseen} unseen); oldest ${b.oldest ? `${b.oldest.messageId}, ${b.oldest.ageMs} ms` : "-"}`,
    );
  const w = m.watchers;
  lines.push(
    `watchers: ${w.unended} unended, ${w.ended} ended; ${w.live} live, ${w.dead} dead, ${w.ownerLost} owner lost, ${w.unverified} unverified; ${w.expired} expired, ${w.stale} stale (overlapping)`,
  );
  return lines.join("\n");
}
