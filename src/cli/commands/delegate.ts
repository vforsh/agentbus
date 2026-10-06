import type { Command } from "commander";
import { workerSettingsPath, writeHooksSettings } from "../../adapters/claude/settings.ts";
import { AgentbusError, EXIT, usageError } from "../../errors.ts";
import { CONTRACT_VERSION, renderContract } from "../../protocol/contract.ts";
import { BODY_LIMIT, type Provider } from "../../protocol/types.ts";
import { requireCaller } from "../../services/caller.ts";
import { delegate, findDelegation, proposeReturnPath, selectDelegation } from "../../services/mailbox.ts";
import { derivePhase } from "../../services/phase.ts";
import { probeDelegations } from "../../services/probe.ts";
import { returnPathResolver } from "../../services/returnpath.ts";
import { delegationsForParent } from "../../store/delegations.ts";
import { getSession, parseLabels } from "../../store/sessions.ts";
import { writeFileAtomic } from "../../util/fsx.ts";
import { canonicalDir, newId } from "../../util/misc.ts";
import { action } from "../action.ts";
import { collect, readBody } from "../context.ts";
import { delegationDetail, delegationsPlain, delegationsTable, delegationView } from "../render.ts";
import { drainBeforeRead, parseKey, parseSummary } from "./messaging.ts";

export function registerDelegate(program: Command): void {
  program
    .command("delegate")
    .description(
      "Open a delegation: pending worker, request and generated worker contract in one transaction",
    )
    .requiredOption("--to <provider>", "worker provider: claude or codex")
    .option("--file <path|->", "request body file, or - for stdin")
    .option("--name <name>", "worker display name")
    .option(
      "--cwd <dir>",
      "worker project directory, final path including any worktree (default: current directory)",
    )
    .option(
      "--allow-missing-cwd",
      "--cwd does not exist yet; the launcher creates it (for example claude --worktree)",
    )
    .option("--key <key>", "idempotency key; a retry returns the same worker, request and contract")
    .option("--summary <text>", "one-line summary")
    .option("--label <k=v>", "display label (repeatable)", collect, [])
    .option("--contract-out <path>", "also write the contract to this file (atomic, private)")
    .option("--dry-run", "validate and print the contract with preview IDs; writes nothing")
    .action(
      action(
        async (
          ctx,
          opts: {
            to: string;
            file?: string;
            name?: string;
            cwd?: string;
            allowMissingCwd?: boolean;
            key?: string;
            summary?: string;
            label: string[];
            contractOut?: string;
            dryRun?: boolean;
          },
        ) => {
          if (opts.to !== "claude" && opts.to !== "codex") throw usageError("--to must be claude or codex");
          const provider = opts.to as Provider;
          const body = await readBody(opts.file, BODY_LIMIT, "request body");
          const summary = parseSummary(opts.summary);
          const key = parseKey(opts.key);
          const labels = parseLabels(opts.label);
          const dir = canonicalDir(opts.cwd ?? process.cwd(), { allowMissing: !!opts.allowMissingCwd });
          const db = ctx.db();
          const caller = requireCaller(db, ctx.opts.as);

          if (opts.dryRun) {
            const workerId = `preview-${newId()}`;
            const requestId = `preview-${newId()}`;
            const rp = proposeReturnPath(caller.session);
            const contract = renderContract({
              provider,
              requestId,
              workerId,
              parentId: caller.session.id,
              cliCommand: ctx.paths.cliCommand,
              stateDir: ctx.paths.stateDir,
              configPath: ctx.paths.configPath,
            });
            ctx.emit(
              { dryRun: true, workerId, requestId, ...rp, contractVersion: CONTRACT_VERSION, contract },
              () => contract,
            );
            return;
          }

          const r = delegate(db, ctx.paths, caller.session, {
            provider,
            body,
            name: opts.name ?? null,
            cwd: dir.display,
            cwdReal: dir.real,
            key,
            summary,
            labels,
          });
          const phase = derivePhase(db, r.delegation);
          // Current evidence, not the creation-time proposal: a watcher armed earlier covers this one too.
          const rp = returnPathResolver(db)(caller.session, r.delegation);
          const data = {
            workerId: r.worker.id,
            requestId: r.request.id,
            sequence: r.request.sequence,
            duplicate: r.duplicate,
            delegation: { phase: phase.phase, state: r.delegation.state },
            returnPath: r.delegation.return_path,
            returnPathStatus: rp.status,
            // Evidence explains itself; without any, the creation-time proposal says what to set up.
            returnPathReason:
              rp.source === "none" ? (r.delegation.return_path_reason ?? rp.reason) : rp.reason,
            returnReadiness: rp,
            contractVersion: r.delegation.contract_version,
            contract: r.delegation.contract,
            contractOut: opts.contractOut ?? null,
            // Claude workers get Agentbus hooks only through this file: `claude --bg --settings <file>`.
            claudeSettings: provider === "claude" ? workerSettingsPath(ctx.paths, r.worker.id) : null,
          };
          if (data.claudeSettings) {
            try {
              writeHooksSettings(data.claudeSettings, ctx.paths);
            } catch (err) {
              throw new AgentbusError(
                "worker_settings_write_failed",
                `Delegation committed but the worker hook settings could not be written: ${(err as Error).message}`,
                EXIT.failure,
                { workerId: r.worker.id, requestId: r.request.id, claudeSettings: data.claudeSettings },
              );
            }
          }
          if (opts.contractOut) {
            try {
              writeFileAtomic(opts.contractOut, `${r.delegation.contract ?? ""}\n`);
            } catch (err) {
              // The delegation is committed; a keyed retry recreates the file without another worker.
              throw new AgentbusError(
                "contract_write_failed",
                `Delegation committed but the contract file could not be written: ${(err as Error).message}`,
                EXIT.failure,
                { workerId: r.worker.id, requestId: r.request.id, contractOut: opts.contractOut },
              );
            }
          }
          ctx.emit(
            data,
            () =>
              `${r.duplicate ? "Recovered" : "Opened"} delegation ${r.request.id}\nworker  ${r.worker.id} (${provider}, pending)\nreturn  ${r.delegation.return_path} — ${rp.status} (${rp.readiness}): ${rp.reason}`,
            () => [r.worker.id, r.request.id, String(r.duplicate)].join("\t"),
          );
        },
      ),
    );

  program
    .command("delegations [targets...]")
    .description("The caller's delegations as a parent: phase, outcome, evidence age and pending question")
    .option("--all", "include delegations closed more than 24 hours ago")
    .option("--global", "every parent's delegations; needs no caller identity")
    .option("--probe", "add live activity and Claude job detail/needs")
    .action(
      action((ctx, targets: string[], opts: { all?: boolean; global?: boolean; probe?: boolean }) => {
        const db = ctx.db();
        // --global skips caller resolution entirely, so an unregistered session can see the board.
        const caller = opts.global ? null : requireCaller(db, ctx.opts.as).session;
        const parentId = caller?.id ?? null;
        const spool = drainBeforeRead(ctx, db);
        const rows =
          targets.length > 0
            ? targets.map((t) => (caller ? selectDelegation(db, caller, t) : findDelegation(db, t, null)))
            : delegationsForParent(db, {
                parentId,
                includeAll: !!opts.all,
                recentSinceIso: new Date(Date.now() - 24 * 3_600_000).toISOString(),
              });
        const probes = opts.probe
          ? probeDelegations(db, ctx.paths, rows, { deadline: Date.now() + 15_000, diagnostics: true })
          : [];
        const readiness = returnPathResolver(db);
        const views = rows.map((d) => {
          const parent = getSession(db, d.parent_id)!;
          const v = delegationView(db, d, derivePhase(db, d), readiness(parent, d));
          const p = probes.find((x) => x.requestId === d.request_id);
          return p ? { ...v, probe: p } : v;
        });
        const detail = targets.length > 0;
        ctx.emit(
          { delegations: views, ...(spool ? { spool } : {}) },
          () =>
            detail
              ? views.map(delegationDetail).join("\n\n")
              : delegationsTable(views, { parents: parentId === null }),
          () => delegationsPlain(views),
        );
      }),
    );
}
