// Worker verbs: `ask` and `finish` carry the protocol a worker would otherwise follow by hand (keys, the
// recovery read before waiting, the final read before a result), the way `take` does for parents.

import type { Command } from "commander";
import pc from "picocolors";
import { EXIT, usageError } from "../../errors.ts";
import { workerBinCommand } from "../../protocol/contract.ts";
import { BODY_LIMIT, DEFAULT_LIMIT, MAX_WAIT_MS, OUTCOMES, type Outcome } from "../../protocol/types.ts";
import { requireCaller } from "../../services/caller.ts";
import { parentMail } from "../../services/followups.ts";
import { replyMessage, workerDelegation } from "../../services/mailbox.ts";
import { runWait } from "../../services/wait.ts";
import { tx } from "../../store/db.ts";
import { getDelegation } from "../../store/delegations.ts";
import { acknowledge, getMessage, type MessageRow, markSeen } from "../../store/messages.ts";
import { endWaitArm } from "../../store/observations.ts";
import { parseDuration } from "../../util/misc.ts";
import { action } from "../action.ts";
import { readBody } from "../context.ts";
import { onInterrupt } from "../interrupt.ts";
import { envelopes } from "../render.ts";
import { drainBeforeRead, parseSummary } from "./messaging.ts";

const ANSWERED = "continue the task with this answer";

function block(label: string, m: MessageRow): string {
  return `${pc.cyan(label)} ${pc.dim(m.id)}${m.summary ? ` — ${pc.bold(m.summary)}` : ""}\n${m.body}`;
}

export function registerWorker(program: Command): void {
  program
    .command("ask")
    .description(
      "Worker: ask your parent a question and wait for the answer, printed in full and acknowledged; re-running it never posts twice",
    )
    .option("--file <path|->", "question body (context and options), or - for stdin")
    .option("--summary <text>", "the question in one line (at most 200 characters)")
    .option("--timeout <duration>", "maximum wait (default 30m, at most 24h)", "30m")
    .option("--no-wait", "post the question and return without waiting")
    .action(
      action(async (ctx, opts: { file?: string; summary?: string; timeout: string; wait: boolean }) => {
        const body = await readBody(opts.file, BODY_LIMIT, "question");
        const summary = parseSummary(opts.summary);
        const timeoutMs = parseDuration(opts.timeout, "--timeout");
        if (timeoutMs > MAX_WAIT_MS) throw usageError("--timeout must be at most 24h");
        const db = ctx.db();
        const caller = requireCaller(db, ctx.opts.as);
        drainBeforeRead(ctx, db);
        const d = workerDelegation(db, caller.session);
        const receipt = replyMessage(db, caller.session, {
          messageId: d.request_id,
          type: "question",
          outcome: null,
          body,
          summary,
          key: null,
        });
        const asked = receipt.message;
        const question = { id: asked.id, key: asked.idempotency_key, duplicate: receipt.duplicate };
        const posted = pc.dim(
          `Question ${asked.id} ${receipt.duplicate ? "was already posted" : "posted"} for request ${d.request_id}.`,
        );

        // An answer acknowledged by an earlier run that died before its output reached you is shown again.
        const earlier = parentMail(db, d).find((m) => m.in_reply_to === asked.id && m.acknowledged_at);
        const open = getDelegation(db, d.request_id)!.state === "open";
        if (earlier || !opts.wait || !open) {
          let next = "end your turn or keep working; the answer arrives as a follow-up";
          if (earlier) next = ANSWERED;
          else if (!open) next = `delegation ${d.request_id} has ended; no answer will come`;
          ctx.emit(
            { origin: null, question, answer: earlier ? envelopes([earlier])[0] : null, messages: [], next },
            () =>
              [posted, ...(earlier ? [block("answer (delivered before)", earlier)] : []), next].join("\n\n"),
          );
          return;
        }

        let armId: string | null = null;
        const release = onInterrupt(() => {
          if (armId) endWaitArm(db, armId, "interrupted");
        });
        const result = await runWait(
          db,
          ctx.paths,
          caller.session,
          {
            timeoutMs,
            probeMs: null,
            after: null,
            fromId: null,
            type: null,
            correlation: d.request_id,
            limit: DEFAULT_LIMIT,
            settled: false,
            replace: true,
            includeSeen: true,
          },
          { setArm: (id) => (armId = id) },
        );
        release();
        // Shown in full here, so acknowledged like `take` does: commit before printing.
        const ids = result.rows.map((m) => m.id);
        const rows = tx(db, () => {
          acknowledge(db, ids);
          return ids.map((id) => getMessage(db, id)!);
        });
        const answer = rows.find((m) => m.in_reply_to === asked.id) ?? null;
        const others = rows.filter((m) => m !== answer);
        if (result.timedOut) ctx.exitCode = EXIT.timeout;
        let next =
          "your parent sent a follow-up instead of an answer: handle it, then run the same ask command to keep waiting";
        if (result.reason === "superseded") next = "a newer wait of yours replaced this one; do not re-run";
        else if (result.timedOut)
          next = "no answer yet: run the same ask command again to keep waiting (it does not post twice)";
        else if (answer) next = ANSWERED;
        ctx.emit(
          {
            // Origin first: the Claude hook attributes the turn this wakes to the wait that woke it.
            origin: result.origin,
            question,
            answer: answer ? envelopes([answer])[0] : null,
            messages: envelopes(others),
            acknowledged: ids,
            timedOut: result.timedOut,
            reason: result.reason,
            next,
          },
          () =>
            [
              posted,
              ...(answer ? [block("answer", answer)] : []),
              ...others.map((m) => block(m.type === "message" ? "follow-up" : m.type, m)),
              ids.length > 0 ? pc.dim(`Acknowledged ${ids.length} message(s).`) : "",
              `Next: ${next}`,
              JSON.stringify({ origin: result.origin }),
            ]
              .filter(Boolean)
              .join("\n\n"),
        );
      }),
    );

  program
    .command("finish")
    .description(
      "Worker: publish your one result; a success first shows any unacknowledged parent follow-ups instead (exit 5)",
    )
    .option("--outcome <outcome>", "success, blocked, failed or unknown", "success")
    .option("--file <path|->", "result body (what changed, verification, open decisions), or - for stdin")
    .option("--summary <text>", "one-line summary (at most 200 characters)")
    .action(
      action(async (ctx, opts: { outcome: string; file?: string; summary?: string }) => {
        if (!(OUTCOMES as readonly string[]).includes(opts.outcome))
          throw usageError(`--outcome must be one of ${OUTCOMES.join(", ")}`);
        const outcome = opts.outcome as Outcome;
        const body = await readBody(opts.file, BODY_LIMIT, "result");
        const summary = parseSummary(opts.summary);
        const db = ctx.db();
        const caller = requireCaller(db, ctx.opts.as);
        drainBeforeRead(ctx, db);
        const d = workerDelegation(db, caller.session);

        // The final read: parent mail a success would be refused over, shown in full instead of by ID.
        const pending = d.state === "open" ? parentMail(db, d).filter((m) => !m.acknowledged_at) : [];
        if (outcome === "success" && pending.length > 0) {
          const ids = pending.map((m) => m.id);
          tx(db, () => markSeen(db, ids, "read"));
          const ack = `${workerBinCommand(ctx.paths.stateDir, caller.session.id)} ack ${ids.join(" ")}`;
          const next = [
            "handle these within the task",
            `acknowledge them: ${ack}`,
            "run the same finish command again",
          ];
          ctx.exitCode = EXIT.conflict;
          ctx.emit(
            { published: false, reason: "followups_pending", followUps: envelopes(pending), next },
            () =>
              [
                pc.yellow(
                  `Not published: your parent sent ${pending.length} message(s) you have not acknowledged.`,
                ),
                ...pending.map((m) => block(m.in_reply_to ? "answer" : "follow-up", m)),
                `Next:\n${next.map((s) => `- ${s}`).join("\n")}`,
              ].join("\n\n"),
          );
          return;
        }

        const r = replyMessage(db, caller.session, {
          messageId: d.request_id,
          type: "result",
          outcome,
          body,
          summary,
          key: null,
        });
        if (r.unhandledFollowUps.length > 0)
          ctx.warn(
            `${r.unhandledFollowUps.length} parent message(s) were never acknowledged; your parent sees them as unhandled`,
          );
        ctx.emit(
          {
            published: true,
            messageId: r.message.id,
            duplicate: r.duplicate,
            key: r.message.idempotency_key,
            requestId: d.request_id,
            outcome,
            unhandledFollowUps: r.unhandledFollowUps,
            next: "end your turn now",
          },
          () =>
            `${r.duplicate ? "Already published" : "Published"} result ${r.message.id} (${outcome}) for request ${d.request_id}. End your turn now.`,
          () => [r.message.id, outcome, String(r.duplicate)].join("\t"),
        );
      }),
    );
}
