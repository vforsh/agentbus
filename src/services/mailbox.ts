import type { Resolved } from "../config/config.ts";
import { AgentbusError, conflict, EXIT, notFound, usageError } from "../errors.ts";
import { CONTRACT_VERSION, renderContract } from "../protocol/contract.ts";
import {
  type MessageType,
  type Outcome,
  type Provider,
  type ReturnPath,
  type ReturnPathStatus,
  TASK_TYPES,
} from "../protocol/types.ts";
import { type Db, SYSTEM_OBSERVER_ID, tx } from "../store/db.ts";
import {
  closeDelegation,
  type DelegationRow,
  delegationsForParent,
  getDelegation,
  insertDelegation,
  openDelegationForWorker,
} from "../store/delegations.ts";
import {
  acknowledge,
  getByKey,
  getMessage,
  insertMessage,
  type MessageRow,
  messagesInCorrelation,
} from "../store/messages.ts";
import { activeTurnForSession } from "../store/observations.ts";
import { getSession, registerSession, type SessionRow } from "../store/sessions.ts";
import { hashIntent, newId } from "../util/misc.ts";
import { followUpCounts, parentMail } from "./followups.ts";

export interface ReturnPathInfo {
  returnPath: ReturnPath;
  returnPathStatus: ReturnPathStatus;
  returnPathReason: string;
}

/** Proposes the parent's return workflow; provider identity alone never proves the mechanism is armed. */
export function proposeReturnPath(parent: SessionRow): ReturnPathInfo {
  if (parent.provider === "claude") {
    return {
      returnPath: "background_wait",
      returnPathStatus: "setup_required",
      returnPathReason: "arm one background `agentbus wait --replace --timeout 30m --probe 60s --json`",
    };
  }
  if (parent.provider === "codex") {
    return {
      returnPath: "heartbeat",
      returnPathStatus: "setup_required",
      returnPathReason:
        "create or reuse one heartbeat on the original chat; without it, poll with `agentbus read`",
    };
  }
  return {
    returnPath: "manual",
    returnPathStatus: "unsupported",
    returnPathReason: "no verified wake facility for this caller; poll with `agentbus read`",
  };
}

function conflictOnKey(key: string, existing: MessageRow): AgentbusError {
  return conflict(
    "idempotency_conflict",
    `Idempotency key "${key}" was already used for a different intent`,
    {
      key,
      messageId: existing.id,
    },
  );
}

export interface SendInput {
  recipient: SessionRow;
  type: "message" | "request";
  body: string;
  summary: string | null;
  key: string | null;
}

export interface SendReceipt {
  message: MessageRow;
  duplicate: boolean;
  delegation: DelegationRow | null;
  /** Request ID of the open delegation this message joined as a follow-up, if any. */
  joined: string | null;
}

export function sendMessage(db: Db, caller: SessionRow, input: SendInput): SendReceipt {
  const intent = {
    kind: "send",
    to: input.recipient.id,
    type: input.type,
    body: input.body,
    summary: input.summary,
    correlation: "self",
    inReplyTo: null,
    outcome: null,
  };
  const hash = hashIntent(intent);
  return tx(db, () => {
    if (input.key) {
      const existing = getByKey(db, caller.id, input.key);
      if (existing) {
        if (existing.intent_hash !== hash) throw conflictOnKey(input.key, existing);
        return {
          message: existing,
          duplicate: true,
          delegation: getDelegation(db, existing.id),
          joined: existing.correlation_id === existing.id ? null : existing.correlation_id,
        };
      }
    }
    if (input.recipient.provider === "system")
      throw usageError("Messages cannot be sent to the system observer");
    if (input.type === "request") {
      if (input.recipient.id === caller.id) throw usageError("A session cannot delegate to itself");
      const busy = openDelegationForWorker(db, input.recipient.id);
      if (busy) {
        throw conflict(
          "worker_busy",
          "The recipient already has an open delegation; start a separate worker session",
          {
            workerId: input.recipient.id,
            openRequestId: busy.request_id,
          },
        );
      }
    }
    // A parent's message to a worker of its open delegation is a follow-up: it joins that correlation, so
    // the worker's correlated read and wait and the Claude doorbell hook all surface it mid-task, and a
    // success result waits for its acknowledgement. Once the delegation has ended this is an ordinary
    // message; `followUp` is the path that refuses instead.
    const open = input.type === "message" ? openDelegationForWorker(db, input.recipient.id) : null;
    const task = open?.parent_id === caller.id ? open : null;
    const message = insertMessage(db, {
      fromId: caller.id,
      toId: input.recipient.id,
      type: input.type,
      summary: input.summary,
      body: input.body,
      correlationId: task?.request_id ?? null,
      inReplyTo: null,
      idempotencyKey: input.key,
      intentHash: hash,
      outcome: null,
      notice: null,
      turnRef: null,
    });
    let delegation: DelegationRow | null = null;
    if (input.type === "request") {
      const rp = proposeReturnPath(caller);
      delegation = insertDelegation(db, {
        requestId: message.id,
        parentId: caller.id,
        workerId: input.recipient.id,
        contractVersion: null,
        contract: null,
        returnPath: rp.returnPath,
        returnPathStatus: rp.returnPathStatus,
        returnPathReason: rp.returnPathReason,
      });
    }
    return { message, duplicate: false, delegation, joined: task?.request_id ?? null };
  });
}

export interface FollowUpInput {
  /** Request ID or unambiguous worker name among the caller's delegations. */
  target: string;
  body: string;
  summary: string | null;
  key: string | null;
}

export interface FollowUpReceipt {
  message: MessageRow;
  duplicate: boolean;
  delegation: DelegationRow;
}

/** A delegation that has ended refuses follow-ups: its worker will not handle them. */
export function assertAcceptsFollowUps(d: DelegationRow): void {
  if (d.state === "open") return;
  throw conflict(
    "delegation_closed",
    `Delegation ${d.request_id} is already ${d.state}${d.outcome ? `/${d.outcome}` : ""}; its worker will not handle a follow-up. Start a new request if the work must continue`,
    { requestId: d.request_id, state: d.state, outcome: d.outcome, resultId: d.result_id },
  );
}

/**
 * A follow-up to the worker of one of the caller's delegations. The open check and the insert share one
 * transaction with the worker's result, so either the follow-up commits first (and a success result waits
 * for its acknowledgement) or the result does (and the follow-up is refused, exit 5): never silently settled.
 */
export function followUp(db: Db, caller: SessionRow, input: FollowUpInput): FollowUpReceipt {
  return tx(db, () => {
    const d = selectDelegation(db, caller, input.target);
    const hash = hashIntent({
      kind: "followup",
      request: d.request_id,
      body: input.body,
      summary: input.summary,
    });
    if (input.key) {
      const existing = getByKey(db, caller.id, input.key);
      if (existing) {
        if (existing.intent_hash !== hash) throw conflictOnKey(input.key, existing);
        return { message: existing, duplicate: true, delegation: getDelegation(db, d.request_id)! };
      }
    }
    assertAcceptsFollowUps(d);
    const message = insertMessage(db, {
      fromId: caller.id,
      toId: d.worker_id,
      type: "message",
      summary: input.summary,
      body: input.body,
      correlationId: d.request_id,
      inReplyTo: null,
      idempotencyKey: input.key,
      intentHash: hash,
      outcome: null,
      notice: null,
      turnRef: null,
    });
    return { message, duplicate: false, delegation: d };
  });
}

export interface ReplyInput {
  messageId: string;
  type: Exclude<MessageType, "notice" | "request">;
  outcome: Outcome | null;
  body: string;
  summary: string | null;
  key: string | null;
  ack?: boolean;
}

export interface ReplyReceipt {
  message: MessageRow;
  duplicate: boolean;
  delegation: DelegationRow | null;
  closedDelegation: boolean;
  attribution: "turn" | "unavailable" | "not_applicable";
  /** Parent follow-ups a non-success result settled without the worker acknowledging them. */
  unhandledFollowUps: string[];
  acknowledged: string[];
}

/** Task replies are attributed to a bound turn when one was active; other replies have no turn. */
function attributionOf(m: MessageRow): ReplyReceipt["attribution"] {
  if (m.turn_ref) return "turn";
  return TASK_TYPES.has(m.type) ? "unavailable" : "not_applicable";
}

export function unresolvedQuestion(msgs: MessageRow[], d: DelegationRow): MessageRow | null {
  const answered = new Set(
    msgs.filter((m) => m.from_id === d.parent_id && m.in_reply_to).map((m) => m.in_reply_to),
  );
  const questions = msgs.filter((m) => m.type === "question" && m.from_id === d.worker_id);
  for (let i = questions.length - 1; i >= 0; i--) {
    const q = questions[i]!;
    if (!answered.has(q.id)) return q;
  }
  return null;
}

export function replyMessage(db: Db, caller: SessionRow, input: ReplyInput): ReplyReceipt {
  if ((input.type === "result") !== (input.outcome !== null)) {
    throw usageError(
      input.type === "result" ? "--outcome is required for a result" : "--outcome is only valid for a result",
    );
  }
  return tx(db, () => {
    const original = getMessage(db, input.messageId);
    if (!original)
      throw notFound("message_not_found", `No message ${input.messageId}`, { messageId: input.messageId });
    if (original.to_id !== caller.id) {
      throw conflict("not_recipient", "Only the original recipient can reply to a message", {
        messageId: original.id,
      });
    }
    const acknowledged = input.ack !== false ? [original.id] : [];
    const intent = {
      kind: "reply",
      to: original.from_id,
      type: input.type,
      body: input.body,
      summary: input.summary,
      correlation: original.correlation_id,
      inReplyTo: original.id,
      outcome: input.outcome,
    };
    const hash = hashIntent(intent);
    if (input.key) {
      const existing = getByKey(db, caller.id, input.key);
      if (existing) {
        if (existing.intent_hash !== hash) throw conflictOnKey(input.key, existing);
        const d = getDelegation(db, existing.correlation_id);
        if (acknowledged.length > 0) acknowledge(db, acknowledged);
        return {
          message: existing,
          duplicate: true,
          delegation: d,
          closedDelegation: false,
          attribution: attributionOf(existing),
          unhandledFollowUps:
            existing.type === "result" && d ? followUpCounts(parentMail(db, d)).unhandledIds : [],
          acknowledged,
        };
      }
    }
    if (original.type === "notice" || original.from_id === SYSTEM_OBSERVER_ID) {
      throw usageError("Notices cannot be replied to; the delegation identifies their worker");
    }
    const delegation = getDelegation(db, original.correlation_id);
    if (
      delegation &&
      delegation.state !== "open" &&
      caller.id === delegation.parent_id &&
      original.from_id === delegation.worker_id
    ) {
      // A late answer or follow-up: the worker no longer handles this delegation, so say so instead of
      // filing mail nobody will act on.
      throw conflict(
        "delegation_closed",
        `Delegation ${delegation.request_id} is already ${delegation.state}${delegation.outcome ? `/${delegation.outcome}` : ""}; its worker will not handle this reply. Start a new request if the work must continue`,
        { requestId: delegation.request_id, state: delegation.state, outcome: delegation.outcome },
      );
    }
    let turnRef: string | null = null;
    let unhandledFollowUps: string[] = [];
    if (TASK_TYPES.has(input.type)) {
      if (!delegation) {
        throw usageError(`${input.type} replies must belong to a delegation; this correlation has none`);
      }
      if (delegation.state !== "open") {
        throw conflict(
          "delegation_closed",
          `Delegation ${delegation.request_id} is already ${delegation.state}`,
          {
            requestId: delegation.request_id,
            state: delegation.state,
          },
        );
      }
      if (caller.id !== delegation.worker_id || original.from_id !== delegation.parent_id) {
        throw conflict("wrong_role", `${input.type} replies go from the delegation's worker to its parent`, {
          requestId: delegation.request_id,
        });
      }
      if (input.type === "question") {
        const pending = unresolvedQuestion(messagesInCorrelation(db, delegation.request_id), delegation);
        if (pending) {
          throw conflict(
            "question_pending",
            "This delegation already has an unresolved question; bundle decisions into it",
            {
              questionId: pending.id,
            },
          );
        }
      }
      if (input.type === "result") {
        const pending = followUpCounts(parentMail(db, delegation));
        if (pending.pending > 0 && input.outcome === "success") {
          throw conflict(
            "followups_pending",
            `${pending.pending} parent follow-up(s) are not acknowledged: ${pending.pendingIds.join(", ")}. Read them with \`read --correlation ${delegation.request_id}\`, handle them, \`ack\` them, then publish the result again with the same --key. Other outcomes are accepted and report them as unhandled`,
            {
              requestId: delegation.request_id,
              pending: pending.pendingIds,
              unseen: pending.unseen,
            },
          );
        }
        // blocked/failed/unknown hand the task back: the parent sees which follow-ups went unhandled.
        unhandledFollowUps = pending.pendingIds;
      }
      const worker = getSession(db, caller.id)!;
      const turn = activeTurnForSession(db, worker.id, worker.generation);
      if (turn && turn.delegation_id === delegation.request_id) turnRef = turn.id;
    }
    const message = insertMessage(db, {
      fromId: caller.id,
      toId: original.from_id,
      type: input.type,
      summary: input.summary,
      body: input.body,
      correlationId: original.correlation_id,
      inReplyTo: original.id,
      idempotencyKey: input.key,
      intentHash: hash,
      outcome: input.outcome,
      notice: null,
      turnRef,
    });
    // Keep acceptance and reply in one commit. Failed validation above never consumes the source mail.
    // The success gate deliberately runs first: replying to a follow-up cannot bypass handling it.
    if (acknowledged.length > 0) acknowledge(db, acknowledged);
    let closed = false;
    if (input.type === "result" && delegation) {
      closed = closeDelegation(db, delegation.request_id, "done", input.outcome, message.id);
      if (!closed) {
        throw conflict("delegation_closed", "The delegation reached a terminal state concurrently", {
          requestId: delegation.request_id,
        });
      }
    }
    return {
      message,
      duplicate: false,
      delegation: delegation ? getDelegation(db, delegation.request_id) : null,
      closedDelegation: closed,
      attribution: attributionOf(message),
      unhandledFollowUps,
      acknowledged,
    };
  });
}

/** Validates the complete set first, then acknowledges atomically; repeats are successes. */
export function ackMessages(db: Db, caller: SessionRow, ids: string[]) {
  return tx(db, () => {
    for (const id of ids) {
      const m = getMessage(db, id);
      if (!m) throw notFound("message_not_found", `No message ${id}`, { messageId: id });
      if (m.to_id !== caller.id) {
        throw conflict("not_recipient", `Message ${id} is not addressed to the caller`, { messageId: id });
      }
    }
    const { newlyAcknowledged } = acknowledge(db, ids);
    return { acknowledged: ids, newlyAcknowledged };
  });
}

/** Selects one of the caller's delegations by request ID or an unambiguous worker name. */
export function selectDelegation(db: Db, caller: SessionRow, target: string): DelegationRow {
  const byId = getDelegation(db, target);
  if (byId && byId.parent_id !== caller.id) {
    throw conflict("not_parent", "Only the delegation's parent can select it", { requestId: target });
  }
  return findDelegation(db, target, caller.id);
}

/**
 * Resolves a request ID or worker name among one parent's delegations (`parentId`), or among all of them
 * (null); a name matching several delegations resolves only to its single open one.
 */
export function findDelegation(db: Db, target: string, parentId: string | null): DelegationRow {
  const byId = getDelegation(db, target);
  if (byId && (parentId === null || byId.parent_id === parentId)) return byId;
  const scope = delegationsForParent(db, { parentId, includeAll: true, recentSinceIso: "" });
  const named = scope.filter((d) => getSession(db, d.worker_id)?.name === target);
  if (named.length === 1) return named[0]!;
  const open = named.filter((d) => d.state === "open");
  if (open.length === 1) return open[0]!;
  if (named.length === 0)
    throw notFound(
      "delegation_not_found",
      `No delegation ${target}${parentId === null ? "" : " for this caller"}`,
      { target },
    );
  throw new AgentbusError(
    "ambiguous_delegation",
    `Name "${target}" matches ${named.length} delegations; use a request ID`,
    EXIT.conflict,
    {
      requestIds: named.map((d) => d.request_id),
    },
  );
}

export function closeByParent(db: Db, caller: SessionRow, target: string) {
  return tx(db, () => {
    const d = selectDelegation(db, caller, target);
    const changed = d.state === "open" ? closeDelegation(db, d.request_id, "closed", null, null) : false;
    return { delegation: getDelegation(db, d.request_id)!, changed };
  });
}

export interface DelegateInput {
  provider: Provider;
  body: string;
  name: string | null;
  cwd: string;
  cwdReal: string;
  key: string | null;
  summary: string | null;
  labels: Record<string, string>;
}

export interface DelegateReceipt {
  worker: SessionRow;
  request: MessageRow;
  delegation: DelegationRow;
  duplicate: boolean;
}

/** Creates a pending worker, sends the request and opens the delegation in one transaction. */
export function delegate(db: Db, paths: Resolved, caller: SessionRow, input: DelegateInput): DelegateReceipt {
  const intent = {
    kind: "delegate",
    provider: input.provider,
    cwd: input.cwdReal,
    body: input.body,
    name: input.name,
    labels: input.labels,
    summary: input.summary,
  };
  const hash = hashIntent(intent);
  return tx(db, () => {
    if (input.key) {
      const existing = getByKey(db, caller.id, input.key);
      if (existing) {
        if (existing.intent_hash !== hash) throw conflictOnKey(input.key, existing);
        const delegation = getDelegation(db, existing.id);
        if (!delegation) throw conflictOnKey(input.key, existing);
        return {
          worker: getSession(db, delegation.worker_id)!,
          request: existing,
          delegation,
          duplicate: true,
        };
      }
    }
    const { row: worker } = registerSession(db, {
      provider: input.provider,
      externalId: null,
      name: input.name,
      cwd: input.cwd,
      cwdReal: input.cwdReal,
      labels: input.labels,
    });
    const requestId = newId();
    const contract = renderContract({
      provider: input.provider,
      requestId,
      workerId: worker.id,
      parentId: caller.id,
      cliCommand: paths.cliCommand,
      stateDir: paths.stateDir,
      configPath: paths.configPath,
    });
    const request = insertMessage(db, {
      id: requestId,
      fromId: caller.id,
      toId: worker.id,
      type: "request",
      summary: input.summary,
      body: input.body,
      correlationId: null,
      inReplyTo: null,
      idempotencyKey: input.key,
      intentHash: hash,
      outcome: null,
      notice: null,
      turnRef: null,
    });
    const rp = proposeReturnPath(caller);
    const delegation = insertDelegation(db, {
      requestId,
      parentId: caller.id,
      workerId: worker.id,
      contractVersion: CONTRACT_VERSION,
      contract,
      returnPath: rp.returnPath,
      returnPathStatus: rp.returnPathStatus,
      returnPathReason: rp.returnPathReason,
    });
    return { worker, request, delegation, duplicate: false };
  });
}
