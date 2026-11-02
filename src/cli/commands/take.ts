import type { Command } from "commander";
import pc from "picocolors";
import { type Envelope, MAX_LIMIT } from "../../protocol/types.ts";
import { requireCaller } from "../../services/caller.ts";
import { selectDelegation } from "../../services/mailbox.ts";
import { derivePhase, isSettled } from "../../services/phase.ts";
import { returnReadiness } from "../../services/returnpath.ts";
import { type Db, tx } from "../../store/db.ts";
import { type DelegationRow, delegationsForParent, getDelegation } from "../../store/delegations.ts";
import { acknowledge, getMessage, type MessageRow, selectInbox, toEnvelope } from "../../store/messages.ts";
import { action } from "../action.ts";
import { nameOf } from "../render.ts";
import { drainBeforeRead } from "./messaging.ts";

interface TakeGroup {
  requestId: string;
  worker: string;
  phase: string;
  outcome: string | null;
  result: Envelope | null;
  questions: Envelope[];
  messages: Envelope[];
  notices: Envelope[];
  progress: { count: number; latest: Envelope | null };
}

const WAIT_HINT = "agentbus wait --ensure --timeout 30m --probe 60s --json";

function group(db: Db, d: DelegationRow, rows: MessageRow[]): TakeGroup {
  const p = derivePhase(db, d);
  const env = rows.map(toEnvelope);
  const progress = env.filter((e) => e.type === "progress");
  return {
    requestId: d.request_id,
    worker: nameOf(db, d.worker_id),
    phase: p.phase,
    outcome: p.outcome,
    result: env.find((e) => e.type === "result") ?? null,
    questions: env.filter((e) => e.type === "question"),
    messages: env.filter((e) => e.type === "message"),
    notices: env.filter((e) => e.type === "notice"),
    progress: { count: progress.length, latest: progress.at(-1) ?? null },
  };
}

function nextSteps(db: Db, parentId: string, groups: TakeGroup[], open: number): string[] {
  const next = groups.flatMap((g) =>
    g.questions.map((q) => `answer question ${q.id}: agentbus reply ${q.id} --file -`),
  );
  if (open > 0) {
    const watched = returnReadiness(db, parentId, null)?.readiness === "armed";
    next.push(
      watched
        ? `${open} delegation(s) still open and a live wait covers them: end the turn`
        : `${open} delegation(s) still open and nothing wakes you: run \`${WAIT_HINT}\` in the background, then end the turn`,
    );
  }
  return next;
}

function groupHuman(g: TakeGroup): string {
  const head = pc.bold(
    `== ${g.worker} · ${g.phase}${g.outcome ? `/${g.outcome}` : ""} · request ${g.requestId}`,
  );
  const parts = [head];
  const block = (label: string, e: Envelope) =>
    `${pc.cyan(label)} ${pc.dim(e.id)}${e.summary ? ` — ${pc.bold(e.summary)}` : ""}\n${e.body}`;
  if (g.result) parts.push(block(`result/${g.result.outcome}`, g.result));
  for (const q of g.questions)
    parts.push(`${block("question (unanswered, not acknowledged)", q)}\n→ agentbus reply ${q.id} --file -`);
  for (const m of g.messages) parts.push(block("message", m));
  for (const n of g.notices) parts.push(`${pc.cyan(`notice/${n.notice?.kind}`)} ${n.summary ?? n.body}`);
  if (g.progress.latest && !g.result) {
    const l = g.progress.latest;
    parts.push(`${pc.cyan(`progress (${g.progress.count}, latest)`)} ${l.summary ?? ""}\n${l.body}`);
  } else if (g.progress.count > 0) {
    parts.push(pc.dim(`${g.progress.count} progress update(s) superseded by the result`));
  }
  return parts.join("\n\n");
}

export function registerTake(program: Command): void {
  program
    .command("take [request]")
    .description(
      "Collect mail from your delegations in one call: results and messages in full, unanswered questions, latest progress; acknowledges what it shows except questions",
    )
    .option("--peek", "show without acknowledging anything")
    .action(
      action((ctx, target: string | undefined, opts: { peek?: boolean }) => {
        const db = ctx.db();
        const caller = requireCaller(db, ctx.opts.as);
        drainBeforeRead(ctx, db);
        const mine = target
          ? [selectDelegation(db, caller.session, target)]
          : delegationsForParent(db, { parentId: caller.session.id, includeAll: true, recentSinceIso: "" });
        const picked = tx(db, () => {
          const batch = selectInbox(db, {
            recipientId: caller.session.id,
            includeAcknowledged: false,
            unseenOnly: false,
            after: null,
            fromId: null,
            type: null,
            correlationIds: mine.map((d) => d.request_id),
            limit: MAX_LIMIT,
          });
          // Questions stay pending: `reply` acknowledges them together with the answer.
          const ids = batch.rows.filter((m) => m.type !== "question").map((m) => m.id);
          if (!opts.peek) acknowledge(db, ids);
          return {
            rows: batch.rows.map((m) => getMessage(db, m.id)!),
            hasMore: batch.hasMore,
            acknowledged: opts.peek ? [] : ids,
          };
        });
        const byCorrelation = Map.groupBy(picked.rows, (m) => m.correlation_id);
        const groups = [...byCorrelation].map(([id, rows]) => group(db, getDelegation(db, id)!, rows));
        // Acknowledging never changes a delegation's state, so the rows read before it are current.
        const open = mine.filter((d) => !isSettled(derivePhase(db, d).phase)).length;
        const next = nextSteps(db, caller.session.id, groups, open);
        if (picked.hasMore) next.unshift("more mail is pending: run `agentbus take` again");
        ctx.emit(
          { delegations: groups, acknowledged: picked.acknowledged, hasMore: picked.hasMore, next },
          () => {
            const body =
              groups.length > 0
                ? groups.map(groupHuman).join("\n\n")
                : pc.dim("No new mail from your delegations.");
            const acked = opts.peek
              ? pc.dim("Peek: nothing acknowledged.")
              : pc.dim(`Acknowledged ${picked.acknowledged.length} message(s).`);
            const steps = next.length > 0 ? `\nNext:\n${next.map((s) => `- ${s}`).join("\n")}` : "";
            return `${body}\n\n${acked}${steps}`;
          },
          () =>
            groups.map((g) =>
              [g.requestId, g.phase, g.outcome ?? "-", g.result?.id ?? "-", String(g.questions.length)].join(
                "\t",
              ),
            ),
        );
      }),
    );
}
