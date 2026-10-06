import type { Command } from "commander";
import pc from "picocolors";
import { drainSpool, spoolCounts } from "../../adapters/claude/spool.ts";
import { conflict, EXIT, notFound, usageError } from "../../errors.ts";
import {
  BODY_LIMIT,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_WAIT_MS,
  MESSAGE_TYPES,
  type MessageType,
  OUTCOMES,
  type Outcome,
  SUMMARY_LIMIT,
} from "../../protocol/types.ts";
import { requireCaller } from "../../services/caller.ts";
import {
  ackMessages,
  assertAcceptsFollowUps,
  closeByParent,
  followUp,
  replyMessage,
  selectDelegation,
  sendMessage,
} from "../../services/mailbox.ts";
import { derivePhase } from "../../services/phase.ts";
import { returnPathResolver } from "../../services/returnpath.ts";
import { runWait, type WaitResult } from "../../services/wait.ts";
import { type Db, tx } from "../../store/db.ts";
import { getDelegation, latestDelegationBetween } from "../../store/delegations.ts";
import {
  acknowledge,
  type Batch,
  getMessage,
  type InboxFilter,
  selectInbox,
  toEnvelope,
} from "../../store/messages.ts";
import { endWaitArm } from "../../store/observations.ts";
import { requireAddress } from "../../store/sessions.ts";
import { newId, parseDuration } from "../../util/misc.ts";
import { action } from "../action.ts";
import { type Ctx, parseLimit, parseSequence, readBody } from "../context.ts";
import { onInterrupt } from "../interrupt.ts";
import { envelopes, messagesHuman, messagesPlain } from "../render.ts";

export function parseSummary(summary: string | undefined): string | null {
  if (summary === undefined) return null;
  if (/[\r\n]/.test(summary)) throw usageError("--summary must be a single line");
  if (summary.length > SUMMARY_LIMIT)
    throw usageError(`--summary must be at most ${SUMMARY_LIMIT} characters`);
  return summary.trim() || null;
}

export function parseKey(key: string | undefined): string | null {
  if (key === undefined) return null;
  if (!/^[A-Za-z0-9._:@/+-]{1,200}$/.test(key))
    throw usageError("--key must be 1-200 characters of [A-Za-z0-9._:@/+-]");
  return key;
}

function parseType(value: string | undefined): MessageType | null {
  if (value === undefined) return null;
  if (!(MESSAGE_TYPES as readonly string[]).includes(value))
    throw usageError(`--type must be one of ${MESSAGE_TYPES.join(", ")}`);
  return value as MessageType;
}

/** read, wait, delegations and status drain the event spool before reading. */
export function drainBeforeRead(ctx: Ctx, db: Db): { backlog: number; quarantined: number } | null {
  try {
    const r = drainSpool(db, ctx.paths);
    if (r.quarantined > 0) ctx.warn(`${r.quarantined} spooled event(s) quarantined; see agentbus doctor`);
  } catch (err) {
    ctx.log(`spool drain skipped: ${(err as Error).message}`);
  }
  const counts = spoolCounts(ctx.paths);
  return counts.backlog > 0 || counts.quarantined > 0 ? counts : null;
}

const delegationSummary = (db: Db, requestId: string | null) => {
  if (!requestId) return null;
  const d = getDelegation(db, requestId);
  if (!d) return null;
  const p = derivePhase(db, d);
  return { requestId: d.request_id, state: d.state, phase: p.phase, outcome: p.outcome };
};

function waitHuman(db: Db, result: WaitResult): string {
  if (result.reason === "superseded") return pc.dim("Superseded by a newer wait of this session.");
  const parts: string[] = [];
  if (result.reason !== "messages") parts.push(pc.bold(result.reason));
  if (result.batch) {
    parts.push(
      result.batch.map((b) => `${b.worker}\t${b.phase}${b.outcome ? `/${b.outcome}` : ""}`).join("\n"),
      "",
    );
  }
  parts.push(messagesHuman(db, result.rows));
  return parts.join("\n");
}

function readBatch(db: Db, filters: InboxFilter, ack: boolean): Batch {
  if (!ack) return selectInbox(db, filters);
  return tx(db, () => {
    const batch = selectInbox(db, filters);
    acknowledge(
      db,
      batch.rows.map((m) => m.id),
    );
    return { ...batch, rows: batch.rows.map((m) => getMessage(db, m.id)!) };
  });
}

export function registerMessaging(program: Command): void {
  program
    .command("send <recipient>")
    .description("Send a message or a new root request (a request opens a delegation)")
    .option("--file <path|->", "body file, or - for stdin")
    .option("--type <type>", "message or request", "message")
    .option("--key <key>", "idempotency key, unique per sender")
    .option("--summary <text>", "one-line summary (at most 200 characters)")
    .option("--dry-run", "validate and describe without writing")
    .action(
      action(
        async (
          ctx,
          recipientArg: string,
          opts: { file?: string; type: string; key?: string; summary?: string; dryRun?: boolean },
        ) => {
          if (opts.type !== "message" && opts.type !== "request") {
            throw usageError(
              "send accepts only --type message or --type request; task replies use `agentbus reply`",
            );
          }
          const body = await readBody(opts.file, BODY_LIMIT);
          const summary = parseSummary(opts.summary);
          const key = parseKey(opts.key);
          const db = ctx.db();
          const caller = requireCaller(db, ctx.opts.as);
          const recipient = requireAddress(db, recipientArg);
          if (opts.dryRun) {
            const preview = {
              dryRun: true,
              messageId: `preview-${newId()}`,
              from: caller.session.id,
              to: recipient.id,
              type: opts.type,
              bytes: Buffer.byteLength(body),
            };
            ctx.emit(preview, () => `Would send ${opts.type} (${preview.bytes} bytes) to ${recipient.id}`);
            return;
          }
          const r = sendMessage(db, caller.session, { recipient, type: opts.type, body, summary, key });
          if (opts.type === "message" && !r.joined) {
            const last = latestDelegationBetween(db, caller.session.id, recipient.id);
            if (last && last.state !== "open")
              ctx.warn(
                `delegation ${last.request_id} to this worker is already ${last.state}; this is an ordinary message, not a follow-up (\`agentbus followup\` refuses instead)`,
              );
          }
          const data = {
            messageId: r.message.id,
            sequence: r.message.sequence,
            duplicate: r.duplicate,
            correlationId: r.message.correlation_id,
            joined: r.joined,
            delegation: r.delegation
              ? {
                  ...delegationSummary(db, r.delegation.request_id),
                  returnPath: r.delegation.return_path,
                  returnPathStatus: returnPathResolver(db)(caller.session, r.delegation).status,
                }
              : null,
          };
          ctx.emit(
            data,
            () =>
              `${r.duplicate ? "Already sent" : "Sent"} ${opts.type} ${r.message.id} (#${r.message.sequence})`,
            () => [r.message.id, String(r.message.sequence), String(r.duplicate)].join("\t"),
          );
        },
      ),
    );

  program
    .command("followup <request>")
    .description(
      "Send a follow-up to the worker of one of your open delegations; refused once it has ended (exit 5)",
    )
    .option("--file <path|->", "body file, or - for stdin")
    .option("--key <key>", "idempotency key, unique per sender")
    .option("--summary <text>", "one-line summary (at most 200 characters)")
    .option("--dry-run", "validate and describe without writing")
    .action(
      action(
        async (
          ctx,
          target: string,
          opts: { file?: string; key?: string; summary?: string; dryRun?: boolean },
        ) => {
          const body = await readBody(opts.file, BODY_LIMIT);
          const summary = parseSummary(opts.summary);
          const key = parseKey(opts.key);
          const db = ctx.db();
          const caller = requireCaller(db, ctx.opts.as);
          if (opts.dryRun) {
            const d = selectDelegation(db, caller.session, target);
            assertAcceptsFollowUps(d);
            ctx.emit(
              { dryRun: true, messageId: `preview-${newId()}`, requestId: d.request_id, state: d.state },
              () =>
                `Would send a follow-up (${Buffer.byteLength(body)} bytes) to delegation ${d.request_id} (${d.state})`,
            );
            return;
          }
          const r = followUp(db, caller.session, { target, body, summary, key });
          const data = {
            messageId: r.message.id,
            sequence: r.message.sequence,
            duplicate: r.duplicate,
            requestId: r.delegation.request_id,
            correlationId: r.message.correlation_id,
            to: r.message.to_id,
            delegation: delegationSummary(db, r.delegation.request_id),
          };
          ctx.emit(
            data,
            () =>
              `${r.duplicate ? "Already sent" : "Sent"} follow-up ${r.message.id} (#${r.message.sequence}) to delegation ${r.delegation.request_id}`,
            () =>
              [r.message.id, String(r.message.sequence), String(r.duplicate), r.delegation.request_id].join(
                "\t",
              ),
          );
        },
      ),
    );

  program
    .command("reply <message-id>")
    .description("Reply and acknowledge the source message; recipient and correlation are derived from it")
    .option("--file <path|->", "body file, or - for stdin")
    .option("--type <type>", "message, progress, question or result", "message")
    .option("--outcome <outcome>", "success, blocked, failed or unknown (results only)")
    .option("--no-ack", "leave the source message unacknowledged")
    .option("--key <key>", "idempotency key, unique per sender")
    .option("--summary <text>", "one-line summary (at most 200 characters)")
    .option("--dry-run", "validate and describe without writing")
    .action(
      action(
        async (
          ctx,
          messageId: string,
          opts: {
            file?: string;
            type: string;
            outcome?: string;
            key?: string;
            summary?: string;
            dryRun?: boolean;
            ack?: boolean;
          },
        ) => {
          if (opts.type === "request")
            throw usageError(
              "reply --type request is not allowed; delegate nested work with a new `delegate` or `send --type request`",
            );
          if (!["message", "progress", "question", "result"].includes(opts.type)) {
            throw usageError("--type must be message, progress, question or result");
          }
          if (opts.outcome !== undefined && !(OUTCOMES as readonly string[]).includes(opts.outcome)) {
            throw usageError(`--outcome must be one of ${OUTCOMES.join(", ")}`);
          }
          const body = await readBody(opts.file, BODY_LIMIT);
          const summary = parseSummary(opts.summary);
          const key = parseKey(opts.key);
          const db = ctx.db();
          const caller = requireCaller(db, ctx.opts.as);
          if (opts.dryRun) {
            ctx.emit(
              { dryRun: true, messageId: `preview-${newId()}`, inReplyTo: messageId, type: opts.type },
              () => `Would reply ${opts.type} to ${messageId}`,
            );
            return;
          }
          // Drain first so a just-captured prompt binding is visible for turn attribution.
          drainBeforeRead(ctx, db);
          const r = replyMessage(db, caller.session, {
            messageId,
            type: opts.type as "message" | "progress" | "question" | "result",
            outcome: (opts.outcome as Outcome | undefined) ?? null,
            body,
            summary,
            key,
            ack: opts.ack,
          });
          const data = {
            messageId: r.message.id,
            sequence: r.message.sequence,
            duplicate: r.duplicate,
            to: r.message.to_id,
            correlationId: r.message.correlation_id,
            inReplyTo: r.message.in_reply_to,
            turnRef: r.message.turn_ref,
            attribution: r.attribution,
            delegation: delegationSummary(db, r.delegation?.request_id ?? null),
            unhandledFollowUps: r.unhandledFollowUps,
            acknowledged: r.acknowledged,
          };
          if (r.attribution === "unavailable")
            ctx.warn("no bound turn found for this reply; finish notices for the turn are not suppressed");
          if (r.unhandledFollowUps.length > 0)
            ctx.warn(
              `${r.unhandledFollowUps.length} parent follow-up(s) were never acknowledged and are reported to the parent as unhandled`,
            );
          ctx.emit(
            data,
            () =>
              `${r.duplicate ? "Already replied" : "Replied"} ${opts.type} ${r.message.id} (#${r.message.sequence})${r.closedDelegation ? " — delegation closed" : ""}`,
            () => [r.message.id, String(r.message.sequence), String(r.duplicate)].join("\t"),
          );
        },
      ),
    );

  program
    .command("show <message-id>")
    .description("Print one message's full body; never changes receipts")
    .action(
      action((ctx, messageId: string) => {
        const db = ctx.db();
        const caller = requireCaller(db, ctx.opts.as);
        drainBeforeRead(ctx, db);
        const message = getMessage(db, messageId);
        if (!message) throw notFound("message_not_found", `No message ${messageId}`, { messageId });
        if (message.to_id !== caller.session.id && message.from_id !== caller.session.id)
          throw conflict("not_participant", "Only the sender or recipient can show a message", { messageId });
        ctx.emit(
          { message: toEnvelope(message) },
          () => message.body,
          () => message.body,
        );
      }),
    );

  program
    .command("read")
    .description("Read the caller's unacknowledged inbox; --ack accepts the returned batch")
    .option("--ack", "acknowledge only the messages returned by this read (after committing, before output)")
    .option("--all", "history mode: include acknowledged messages")
    .option("--unseen", "only unseen messages")
    .option("--after <seq>", "only messages after this sequence")
    .option("--from <address>", "only messages from this sender")
    .option("--type <type>", "only this message type")
    .option("--correlation <id>", "only this correlation (request ID)")
    .option("--limit <n>", `maximum records (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT})`)
    .action(
      action(
        (
          ctx,
          opts: {
            all?: boolean;
            ack?: boolean;
            unseen?: boolean;
            after?: string;
            from?: string;
            type?: string;
            correlation?: string;
            limit?: string;
          },
        ) => {
          if (opts.all && opts.unseen) throw usageError("--all and --unseen are incompatible");
          const db = ctx.db();
          const caller = requireCaller(db, ctx.opts.as);
          const spool = drainBeforeRead(ctx, db);
          const after = parseSequence(opts.after, "--after");
          const filters = {
            recipientId: caller.session.id,
            includeAcknowledged: !!opts.all,
            unseenOnly: !!opts.unseen,
            after,
            fromId: opts.from ? requireAddress(db, opts.from, "sender").id : null,
            type: parseType(opts.type),
            correlationIds: opts.correlation ? [opts.correlation] : null,
            limit: parseLimit(opts.limit, DEFAULT_LIMIT, MAX_LIMIT),
          };
          const batch = readBatch(db, filters, !!opts.ack);
          const cursor = batch.rows.length > 0 ? batch.rows[batch.rows.length - 1]!.sequence : after;
          ctx.emit(
            {
              messages: envelopes(batch.rows),
              cursor,
              hasMore: batch.hasMore,
              ...(opts.ack ? { acknowledged: batch.rows.map((m) => m.id) } : {}),
              ...(spool ? { spool } : {}),
            },
            () =>
              messagesHuman(db, batch.rows) +
              (batch.hasMore ? `\n\n${pc.yellow(`More messages available: --after ${cursor}`)}` : ""),
            () => messagesPlain(batch.rows),
          );
        },
      ),
    );

  program
    .command("wait")
    .description("Wait for unseen messages and atomically mark the returned batch seen (never acknowledges)")
    .option("--timeout <duration>", "maximum wait (default 60s, at most 24h)", "60s")
    .option("--settled", "batch mode: return on attention events or when every captured delegation settles")
    .option("--probe <interval>", "probe open delegations' liveness at this interval (at least 10s)")
    .option("--replace", "retire the caller's other running waits, which exit with reason superseded")
    .option("--after <seq>", "only messages after this sequence")
    .option("--from <address>", "only messages from this sender")
    .option("--type <type>", "only this message type")
    .option("--correlation <id>", "only this correlation (request ID)")
    .option("--limit <n>", `maximum records (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT})`)
    .action(
      action(
        async (
          ctx,
          opts: {
            timeout: string;
            settled?: boolean;
            probe?: string;
            replace?: boolean;
            after?: string;
            from?: string;
            type?: string;
            correlation?: string;
            limit?: string;
          },
        ) => {
          const timeoutMs = parseDuration(opts.timeout, "--timeout");
          if (timeoutMs > MAX_WAIT_MS) throw usageError("--timeout must be at most 24h");
          const probeMs = opts.probe ? parseDuration(opts.probe, "--probe") : null;
          if (probeMs !== null && probeMs < 10_000) throw usageError("--probe must be at least 10s");
          if (opts.settled && (opts.after || opts.from || opts.type)) {
            throw usageError("--settled cannot be combined with --after, --from or --type");
          }
          const db = ctx.db();
          const caller = requireCaller(db, ctx.opts.as);
          const fault = process.env.AGENTBUS_FAULT_INJECT === "wait-after-seen-commit";
          let armId: string | null = null;
          const release = onInterrupt(() => {
            if (armId) endWaitArm(db, armId, "interrupted");
          });
          const after = parseSequence(opts.after, "--after");
          const result = await runWait(
            db,
            ctx.paths,
            caller.session,
            {
              timeoutMs,
              probeMs,
              after,
              fromId: opts.from ? requireAddress(db, opts.from, "sender").id : null,
              type: parseType(opts.type),
              correlation: opts.correlation ?? null,
              limit: parseLimit(opts.limit, DEFAULT_LIMIT, MAX_LIMIT),
              settled: !!opts.settled,
              replace: !!opts.replace,
            },
            {
              setArm: (id) => {
                armId = id;
              },
              afterSeenCommit: fault ? () => process.exit(137) : undefined,
            },
          );
          release();
          const cursor = result.rows.length > 0 ? result.rows[result.rows.length - 1]!.sequence : after;
          if (result.timedOut) ctx.exitCode = EXIT.timeout;
          ctx.emit(
            {
              // Origin first: hooks find it at the head of large receipts without parsing message bodies.
              origin: result.origin,
              messages: envelopes(result.rows),
              cursor,
              hasMore: result.hasMore,
              timedOut: result.timedOut,
              reason: result.reason,
              batch: result.batch,
              replaced: result.replaced,
              recovery:
                result.reason === "superseded"
                  ? "a newer wait of this session is running; do not re-arm"
                  : "run a paginated `agentbus read` sweep before re-arming",
            },
            () =>
              result.timedOut
                ? pc.dim(
                    "Timed out with no new messages; run `agentbus read` to recover pending mail before re-arming.",
                  )
                : waitHuman(db, result),
            () => messagesPlain(result.rows),
          );
        },
      ),
    );

  program
    .command("ack <message-id...>")
    .description("Acknowledge messages addressed to the caller (atomic and idempotent)")
    .action(
      action((ctx, ids: string[]) => {
        const db = ctx.db();
        const caller = requireCaller(db, ctx.opts.as);
        const r = ackMessages(db, caller.session, ids);
        ctx.emit(
          r,
          () => `Acknowledged ${ids.length} message(s)`,
          () => ids,
        );
      }),
    );

  program
    .command("close <request>")
    .description("Parent closes an open delegation without a result (never stops a process)")
    .action(
      action((ctx, target: string) => {
        const db = ctx.db();
        const caller = requireCaller(db, ctx.opts.as);
        const r = closeByParent(db, caller.session, target);
        ctx.emit(
          { requestId: r.delegation.request_id, state: r.delegation.state, changed: r.changed },
          () =>
            r.changed
              ? `Closed delegation ${r.delegation.request_id}`
              : `Delegation ${r.delegation.request_id} is already ${r.delegation.state}`,
          () => [r.delegation.request_id, r.delegation.state, String(r.changed)].join("\t"),
        );
      }),
    );
}
