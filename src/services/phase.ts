import type { Outcome, Phase } from "../protocol/types.ts";
import type { Db } from "../store/db.ts";
import type { DelegationRow } from "../store/delegations.ts";
import { type MessageRow, messagesInCorrelation } from "../store/messages.ts";
import { latestTurn, launchFailure, type TurnRow } from "../store/observations.ts";
import { getSession } from "../store/sessions.ts";
import { unresolvedQuestion } from "./mailbox.ts";

export interface PhaseInfo {
  phase: Phase;
  reason: string;
  evidenceAt: string;
  outcome: Outcome | null;
  pendingQuestion: { id: string; summary: string | null } | null;
  backgroundRunning: number | null;
  turnRef: string | null;
  tracking: "ok" | "lost" | "none";
  latestSummary: string | null;
}

const maxIso = (...xs: (string | null | undefined)[]): string =>
  xs.filter((x): x is string => !!x).reduce((a, b) => (a > b ? a : b), "");

/**
 * Derives a delegation's phase from its messages, turn bindings and observations. Terminal state wins;
 * then the current binding generation; failure, interruption and tracking loss override activity.
 */
export function derivePhase(db: Db, d: DelegationRow): PhaseInfo {
  const msgs = messagesInCorrelation(db, d.request_id);
  const latestSummary = lastSummary(msgs, d);
  const lastMsgAt = msgs.length > 0 ? msgs[msgs.length - 1]!.created_at : d.opened_at;
  const base = { outcome: d.outcome, latestSummary, backgroundRunning: null, turnRef: null } as const;

  if (d.state === "done") {
    return {
      ...base,
      phase: "done",
      reason: "worker published a result",
      evidenceAt: d.closed_at ?? lastMsgAt,
      pendingQuestion: null,
      tracking: "none",
    };
  }
  if (d.state === "closed") {
    return {
      ...base,
      phase: "closed",
      reason: "closed by the parent without a result",
      evidenceAt: d.closed_at ?? lastMsgAt,
      pendingQuestion: null,
      tracking: "none",
    };
  }

  const question = unresolvedQuestion(msgs, d);
  const pendingQuestion = question ? { id: question.id, summary: question.summary } : null;
  const worker = getSession(db, d.worker_id);
  const turn = latestTurn(db, d.request_id);

  if (!turn) {
    // Messages-only derivation: generic workers and Claude/Codex workers before their first bound turn.
    const lastWorker = [...msgs].reverse().find((m) => m.from_id === d.worker_id);
    const failure = worker ? launchFailure(db, d.request_id, worker.generation) : null;
    if (failure) {
      const reason = (JSON.parse(failure.detail) as { reason?: string }).reason;
      return phase(
        "interrupted",
        reason ?? "worker session ended before claiming the request",
        failure.captured_at,
      );
    }
    if (question) return phase("question", "worker asked a question", question.created_at);
    const answer = latestAnswer(msgs, d);
    if (answer && (!lastWorker || answer.sequence > lastWorker.sequence)) {
      return phase(
        "pending",
        "answer delivered to the mailbox; no bound turn observed yet",
        answer.created_at,
      );
    }
    if (lastWorker?.type === "progress")
      return phase("working", "worker reported progress", lastWorker.created_at);
    return phase(
      "pending",
      worker?.external_id ? "no bound turn observed yet" : "worker not yet launched or claimed",
      lastMsgAt,
    );
  }

  const evidence = maxIso(turn.evidence_at, lastMsgAt);
  const withTurn = (p: Phase, reason: string, at = evidence): PhaseInfo => ({
    ...base,
    phase: p,
    reason,
    evidenceAt: at,
    pendingQuestion,
    backgroundRunning: turn.bg_running,
    turnRef: turn.id,
    tracking: turn.tracking,
  });

  if (worker && worker.generation > turn.generation) {
    return withTurn("unknown", "binding superseded by unrelated input to the worker session");
  }
  if (turn.state === "failed") return withTurn("interrupted", "latest bound turn failed");
  if (turn.state === "interrupted") return withTurn("interrupted", "latest bound turn was interrupted");
  if (turn.tracking === "lost") return withTurn("unknown", turn.tracking_reason ?? "tracking lost");
  if (turn.state === "active" && turn.permission_at && !progressSince(msgs, turn, turn.permission_at)) {
    return withTurn("permission", "permission request observed with no later evidence of resumption");
  }
  if (question)
    return withTurn("question", "worker asked a question", maxIso(question.created_at, turn.evidence_at));
  if (turn.state === "active") return withTurn("working", "bound turn is active");
  if (turn.state === "prepared") return withTurn("pending", "run prepared; turn not started yet");
  const answer = latestAnswer(msgs, d);
  if (answer && turn.ended_at && answer.created_at > turn.ended_at) {
    return withTurn("pending", "answer delivered to the mailbox; worker has not started a new bound turn");
  }
  if ((turn.bg_running ?? 0) > 0)
    return withTurn("working", "turn ended with delegated background work still running");
  if (turn.kind === "claude_prompt" && turn.bg_running === null) {
    // A missing background-task list is not an empty one: it cannot count as idle or settled.
    return withTurn("unknown", "turn ended but its background task list was unavailable");
  }
  return withTurn("idle", "bound work ended without a result");

  function phase(p: Phase, reason: string, at: string): PhaseInfo {
    return { ...base, phase: p, reason, evidenceAt: at, pendingQuestion, tracking: "none" };
  }
}

function progressSince(msgs: MessageRow[], turn: TurnRow, sinceIso: string): boolean {
  return msgs.some((m) => m.turn_ref === turn.id && m.type === "progress" && m.created_at > sinceIso);
}

function latestAnswer(msgs: MessageRow[], d: DelegationRow): MessageRow | null {
  const questionIds = new Set(
    msgs.filter((m) => m.type === "question" && m.from_id === d.worker_id).map((m) => m.id),
  );
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.from_id === d.parent_id && m.in_reply_to && questionIds.has(m.in_reply_to)) return m;
  }
  return null;
}

function lastSummary(msgs: MessageRow[], d: DelegationRow): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.to_id === d.parent_id && m.summary) return m.summary;
  }
  return msgs[0]?.summary ?? null;
}

/** A batch member counts as settled only when terminal or positively idle. */
export const isSettled = (p: Phase): boolean => p === "done" || p === "closed" || p === "idle";
