import type { Command } from "commander";
import { drainSpool } from "../../adapters/claude/spool.ts";
import { ingestRunnerEvent, parseRunnerEvent } from "../../adapters/codex/runner-events.ts";
import { inputError, usageError } from "../../errors.ts";
import { action } from "../action.ts";
import { readBody } from "../context.ts";

export function registerEvent(program: Command): void {
  const event = program.command("event").description("Provider event ingestion (hooks and runners)");

  event
    .command("ingest")
    .description("Ingest one provider event: Claude hooks (--source hook, silent) or Codex runner events")
    .requiredOption("--provider <provider>", "claude or codex")
    .requiredOption("--source <source>", "hook (Claude) or runner (Codex)")
    .option("--file <path|->", "event file, or - for stdin (default for hooks: stdin)")
    .action(
      action(async (ctx, opts: { provider: string; source: string; file?: string }) => {
        if (opts.provider === "claude" && opts.source === "hook") {
          // Normally dispatched before Commander loads; kept here so the command is discoverable.
          const { runHook } = await import("../../adapters/claude/hook.ts");
          await runHook({ stateDir: ctx.opts.stateDir, config: ctx.opts.config });
          return;
        }
        if (opts.provider !== "codex" || opts.source !== "runner") {
          throw usageError(
            "Supported sources: --provider claude --source hook, --provider codex --source runner",
          );
        }
        const text = await readBody(opts.file ?? "-", 2 * 1024 * 1024, "runner event");
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch (err) {
          throw inputError(
            "invalid_runner_event",
            `Runner event is not valid JSON: ${(err as Error).message}`,
          );
        }
        const ev = parseRunnerEvent(raw);
        const r = ingestRunnerEvent(ctx.db(), ev);
        ctx.emit(
          r,
          () =>
            `${r.status === "duplicate" ? "Already ingested" : "Ingested"} ${ev.kind} for run ${ev.runId}${r.noticeId ? ` (notice ${r.noticeId})` : ""}`,
          () => [r.status, r.observationId, r.noticeId ?? "-"].join("\t"),
        );
      }),
    );

  event
    .command("drain")
    .description("Ingest spooled hook events in capture order")
    .option("--max <n>", "maximum files per batch", "100")
    .action(
      action((ctx, opts: { max: string }) => {
        const max = Number(opts.max);
        if (!Number.isSafeInteger(max) || max <= 0) throw usageError("--max must be a positive integer");
        const r = drainSpool(ctx.db(), ctx.paths, max);
        ctx.emit(
          r,
          () =>
            `Drained ${r.ingested} event(s); ${r.duplicates} duplicate, ${r.ignored} ignored, ${r.quarantined} quarantined, ${r.remaining} remaining${r.busy ? " (store busy)" : ""}`,
          () => [r.ingested, r.duplicates, r.ignored, r.quarantined, r.remaining].join("\t"),
        );
      }),
    );
}
