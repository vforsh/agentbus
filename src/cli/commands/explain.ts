import type { Command } from "commander";
import pc from "picocolors";
import { MAX_LIMIT } from "../../protocol/types.ts";
import { requireCaller } from "../../services/caller.ts";
import { type Explanation, explainDelegation } from "../../services/explain.ts";
import { findDelegation, selectDelegation } from "../../services/mailbox.ts";
import { derivePhase } from "../../services/phase.ts";
import { probeDelegations } from "../../services/probe.ts";
import { getDelegation } from "../../store/delegations.ts";
import { formatAge } from "../../util/misc.ts";
import { action } from "../action.ts";
import { parseLimit } from "../context.ts";
import { type DelegationView, delegationView, followUpLine } from "../render.ts";

const DEFAULT_EVENTS = 40;

export function registerExplain(program: Command): void {
  program
    .command("explain <request>")
    .description(
      "Explain one delegation: chronological evidence, why it is where it is, and safe next steps (changes nothing)",
    )
    .option("--global", "select among every parent's delegations; needs no caller identity")
    .option(
      "--probe",
      "probe the worker's liveness first (runs provider subprocesses; records probe evidence)",
    )
    .option("--limit <n>", `newest timeline events to show (default ${DEFAULT_EVENTS}, at most ${MAX_LIMIT})`)
    .action(
      action((ctx, target: string, opts: { global?: boolean; probe?: boolean; limit?: string }) => {
        const limit = parseLimit(opts.limit, DEFAULT_EVENTS, MAX_LIMIT);
        const db = ctx.db();
        const caller = opts.global ? null : requireCaller(db, ctx.opts.as).session;
        const selected = caller ? selectDelegation(db, caller, target) : findDelegation(db, target, null);
        // Read-only unless --probe: no spool drain, acknowledgement or recovery happens here.
        const probe = opts.probe
          ? (probeDelegations(db, ctx.paths, [selected], {
              deadline: Date.now() + 15_000,
              diagnostics: true,
            })[0] ?? null)
          : null;
        const d = getDelegation(db, selected.request_id)!;
        const x = explainDelegation(db, ctx.paths, d, { limit, probe });
        const view = delegationView(db, d, derivePhase(db, d), x.diagnosis.returnPath);
        ctx.emit(
          {
            delegation: view,
            diagnosis: x.diagnosis,
            timeline: x.timeline,
            actions: x.actions,
            probe: x.probe,
          },
          () => explainHuman(view, x),
          () => explainPlain(view, x),
        );
      }),
    );
}

const clock = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 19)}Z`;

function explainHuman(v: DelegationView, x: Explanation): string {
  const g = x.diagnosis;
  const rp = g.returnPath;
  const turn = g.turn
    ? `turn ${g.turn.id.slice(0, 8)} ${g.turn.state} (${g.turn.origin}, gen ${g.turn.generation}${g.turn.current ? "" : ", superseded"})`
    : "no bound turn";
  const lines = [
    `${pc.bold(v.name)} ${v.requestId}`,
    `phase     ${v.phase}${v.outcome ? `/${v.outcome}` : ""} — ${g.reason} (${g.evidenceAge} ago)`,
    `status    ${g.stalled ? pc.yellow(g.summary) : g.summary}`,
    `worker    ${g.worker.provider} ${g.worker.externalId ?? "unbound"}${g.worker.shortId ? ` short ${g.worker.shortId}` : ""}; ${turn}`,
    `mail      ${v.parent.name}: ${g.parentInbox.pending} unacknowledged (${g.parentInbox.unseen} never delivered)`,
  ];
  if (g.followUps.total > 0) lines.push(`followups ${followUpLine(g.followUps)}`);
  if (g.worker.wait) lines.push(`worker    own wait ${g.worker.wait.readiness}: ${g.worker.wait.reason}`);
  lines.push(
    `return    ${rp.strategy} — ${rp.status} (${rp.readiness}): ${rp.reason}`,
    `handoff   ${g.handoff.ready ? "ready" : "not ready"} — ${g.handoff.reason}`,
  );
  if (x.probe)
    lines.push(
      `probe     ${x.probe.evidence}, ${x.probe.activity}, owner ${x.probe.owner}: ${x.probe.reason}`,
    );
  for (const u of g.uncertain) lines.push(`${pc.dim("uncertain")} ${u}`);

  const t = x.timeline;
  lines.push(
    "",
    pc.bold(
      `Timeline (${t.shown} of ${t.total} events${t.omitted > 0 ? `; ${t.omitted} older omitted, raise --limit` : ""})`,
    ),
  );
  const now = Date.now();
  for (const e of t.events) {
    const receipt = e.receipt ? pc.dim(` [${e.receipt}]`) : "";
    const ref = e.refs.messageId ? pc.dim(` ${e.refs.messageId.slice(0, 8)}`) : "";
    lines.push(
      `  ${clock(e.at)} ${formatAge(e.at, now).padStart(4)}  ${e.actor.padEnd(8)} ${pc.dim(e.source.padEnd(12))} ${e.text}${ref}${receipt}`,
    );
  }
  lines.push("", pc.bold("Next"));
  x.actions.forEach((a, i) => {
    lines.push(`  ${i + 1}. ${a.title}`, `     ${pc.dim(a.why)}`);
    for (const c of a.commands) lines.push(`     $ ${c}`);
  });
  return lines.join("\n");
}

function explainPlain(v: DelegationView, x: Explanation): string[] {
  return [
    [
      v.requestId,
      v.phase,
      v.outcome ?? "-",
      x.diagnosis.returnPath.status,
      x.diagnosis.stalled ? "stalled" : "-",
    ].join("\t"),
    ...x.timeline.events.map((e) => ["event", e.at, e.actor, e.kind, e.text].join("\t")),
    ...x.actions.map((a) => ["action", a.kind, a.title].join("\t")),
  ];
}
