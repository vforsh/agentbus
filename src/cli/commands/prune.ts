import type { Command } from "commander";
import { type PruneResult, prune, pruneWindow } from "../../store/prune.ts";
import { action } from "../action.ts";
import { drainBeforeRead } from "./messaging.ts";

function pruneHuman(r: PruneResult): string {
  const c = r.counts;
  if (!r.dryRun) {
    return `Pruned ${c.workers} worker(s), ${c.delegations} delegation(s), ${c.messages} message(s), ${c.observations} observation(s) finished before ${r.cutoff}`;
  }
  const head = `Would prune ${c.workers} worker(s) with ${c.delegations} delegation(s) and ${c.messages} message(s) finished before ${r.cutoff}`;
  return [head, ...r.pruned.map((w) => `  ${w.name ?? w.workerId}\t${w.requestIds.join(",")}`)].join("\n");
}

export function registerPrune(program: Command): void {
  program
    .command("prune")
    .description(
      "Delete finished workers with their delegations, mail and observations (every parent's; never unacknowledged mail)",
    )
    .option(
      "--older-than <duration>",
      "only delegations that ended at least this long ago (default: config pruneOlderThan, else 7d)",
    )
    .option("--dry-run", "report what would be deleted without writing")
    .action(
      action((ctx, opts: { olderThan?: string; dryRun?: boolean }) => {
        const { cutoff, liveSince } = pruneWindow(opts.olderThan ?? ctx.paths.pruneOlderThan);
        const db = ctx.db();
        // Spooled hook events may show a worker is still active; ingest them before deciding.
        drainBeforeRead(ctx, db);
        const r = prune(db, { cutoff, liveSince, dryRun: !!opts.dryRun });
        ctx.emit(
          r,
          () => pruneHuman(r),
          () => r.pruned.map((w) => [w.workerId, w.name ?? "-", w.requestIds.join(",")].join("\t")),
        );
      }),
    );
}
