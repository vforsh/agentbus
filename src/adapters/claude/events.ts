// Claude hook ingestion: normalizes captured hook payloads into turn bindings, observations and notices.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parseContract } from "../../protocol/contract.ts";
import { unresolvedQuestion } from "../../services/mailbox.ts";
import {
  lastNoticeBody,
  noticeBlocker,
  ORPHANED_BACKGROUND_REASON,
  record,
  turnHasExplicitReport,
} from "../../services/observe.ts";
import { type Db, tx } from "../../store/db.ts";
import { type DelegationRow, getDelegation, openDelegationForWorker } from "../../store/delegations.ts";
import { messagesInCorrelation } from "../../store/messages.ts";
import {
  activeTurnForSession,
  getTurn,
  getWaitArm,
  insertTurn,
  latestTurn,
  observationExists,
  type TurnRow,
  turnByNative,
  updateTurn,
} from "../../store/observations.ts";
import { findByExternal, getSession, patchAdapterBinding, type SessionRow } from "../../store/sessions.ts";
import { newId, nowIso, oneLine, realOrSelf } from "../../util/misc.ts";

export const CLAUDE_SOURCE_SCHEMA = "claude-hook-v1";

export interface WaitOrigin {
  armId: string;
  sessionId: string;
  delegationId: string | null;
  turnRef: string | null;
}

/** A captured hook event: allocated once at capture, retained through retries and spooling. */
export interface CapturedClaudeEvent {
  schemaVersion: 1;
  sourceEventId: string;
  capturedAt: string;
  provider: "claude";
  source: "hook";
  sourceSchema: typeof CLAUDE_SOURCE_SCHEMA;
  payload: Record<string, unknown>;
  /** Present when the prompt is a task notification whose output holds an Agentbus wait receipt. */
  waitOrigin?: WaitOrigin | null;
  truncated?: Record<string, number>;
}

export type IngestStatus = "ingested" | "duplicate" | "ignored";

export interface IngestResult {
  status: IngestStatus;
  reason?: string;
  observationIds: string[];
  noticeIds: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export const promptText = (p: Record<string, unknown>): string => str(p.prompt) ?? str(p.user_prompt) ?? "";

interface TaskNotification {
  taskId: string;
  outputFile: string | null;
  status: string | null;
}

export function parseTaskNotification(prompt: string): TaskNotification | null {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith("<task-notification>")) return null;
  const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(trimmed)?.[1]?.trim() ?? null;
  const taskId = tag("task-id");
  if (!taskId) return null;
  return { taskId, outputFile: tag("output-file"), status: tag("status") };
}

/**
 * Reads the tail of a background task's output file and extracts an Agentbus wait origin. The path must
 * be this session's own task output for the notified task ID; the database later verifies the arm.
 */
const ORIGIN_RE =
  /"origin":\{"agentbusWaitOrigin":1,"armId":"([0-9a-f-]{36})","sessionId":"([0-9a-f-]{36})","delegationId":(null|"[0-9a-f-]{36}"),"turnRef":(null|"[0-9a-f-]{36}")\}/g;
const ORIGIN_WINDOW = 256 * 1024;

export function readWaitOrigin(sessionId: string, n: TaskNotification): WaitOrigin | null {
  if (!n.outputFile) return null;
  if (basename(n.outputFile) !== `${n.taskId}.output`) return null;
  if (!n.outputFile.includes(`/${sessionId}/tasks/`)) return null;
  const chunks: string[] = [];
  try {
    const size = statSync(n.outputFile).size;
    const fd = openSync(n.outputFile, "r");
    try {
      // `wait --json` emits the origin first in its receipt, so the head normally holds it; the tail
      // covers output written after the receipt. Bodies in between are never parsed.
      for (const [pos, len] of size <= 2 * ORIGIN_WINDOW
        ? [[0, size]]
        : [
            [0, ORIGIN_WINDOW],
            [size - ORIGIN_WINDOW, ORIGIN_WINDOW],
          ]) {
        const buf = Buffer.alloc(len!);
        readSync(fd, buf, 0, len!, pos!);
        chunks.push(buf.toString("utf8"));
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let found: WaitOrigin | null = null;
  for (const text of chunks) {
    for (const m of text.matchAll(ORIGIN_RE)) {
      const unq = (v: string) => (v === "null" ? null : v.slice(1, -1));
      found = { armId: m[1]!, sessionId: m[2]!, delegationId: unq(m[3]!), turnRef: unq(m[4]!) };
    }
  }
  return found;
}

/** Sessions worth observing: workers with an open delegation or with any recorded turn binding. */
export function isObservedWorker(db: Db, sessionId: string): boolean {
  if (openDelegationForWorker(db, sessionId)) return true;
  return !!db
    .query<{ id: string }, [string]>("SELECT id FROM turn_bindings WHERE session_id = ? LIMIT 1")
    .get(sessionId);
}

function occurrenceKey(ev: CapturedClaudeEvent): string | null {
  const p = ev.payload;
  const name = str(p.hook_event_name);
  const sid = str(p.session_id);
  if (name === "UserPromptSubmit" && sid && str(p.prompt_id)) return `claude:ups:${sid}:${p.prompt_id}`;
  if (name === "PermissionRequest" && str(p.tool_use_id)) return `claude:perm:${p.tool_use_id}`;
  return null;
}

function runningTaskIds(p: Record<string, unknown>): string[] | null {
  if (!Array.isArray(p.background_tasks)) return null;
  return p.background_tasks
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .filter((t) => t.status === "running" || t.status === undefined)
    .map((t) => String(t.id ?? ""))
    .filter((id) => id.length > 0);
}

function permissionSummary(p: Record<string, unknown>): string {
  const tool = str(p.tool_name) ?? "tool";
  const input =
    p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
  // Descriptions are author-written labels; raw arguments may carry secrets, so only their names are shown.
  const description = str(input.description);
  const names = Array.isArray(input._keys) ? (input._keys as unknown[]).map(String) : Object.keys(input);
  const keys = names.slice(0, 8).join(", ");
  return description ? `${tool}: ${oneLine(description, 160)}` : `${tool} (${keys || "no input"})`;
}

/** Ingests one captured event in a single transaction; replaying the same captured ID ingests once. */
export function ingestClaudeEvent(db: Db, ev: CapturedClaudeEvent): IngestResult {
  return tx(db, () => ingestInTx(db, ev));
}

function ingestInTx(db: Db, ev: CapturedClaudeEvent): IngestResult {
  const out: IngestResult = { status: "ingested", observationIds: [], noticeIds: [] };
  const p = ev.payload;
  const event = str(p.hook_event_name);
  const nativeSid = str(p.session_id);
  if (!event || !nativeSid) return { ...out, status: "ignored", reason: "missing_identity" };
  const occ = occurrenceKey(ev);
  if (observationExists(db, ev.sourceEventId, occ)) return { ...out, status: "duplicate" };

  const track = (r: { observationId: string; noticeId: string | null }) => {
    out.observationIds.push(r.observationId);
    if (r.noticeId) out.noticeIds.push(r.noticeId);
  };
  const baseObs = (
    session: SessionRow,
    d: DelegationRow | null,
    turn: TurnRow | null,
    kind: string,
    detail = {},
  ) => ({
    id: ev.sourceEventId,
    occurrenceKey: occ,
    sessionId: session.id,
    delegationId: d?.request_id ?? turn?.delegation_id ?? null,
    turnRef: turn?.id ?? null,
    generation: turn?.generation ?? session.generation,
    source: "claude-hook" as const,
    kind,
    nativeEvent: event,
    nativeTurnId: str(p.prompt_id),
    capturedAt: ev.capturedAt,
    detail: { ...detail, ...(ev.truncated ? { truncated: ev.truncated } : {}) },
  });

  let session = findByExternal(db, "claude", nativeSid);

  if (event === "UserPromptSubmit") {
    const contract = parseContract(promptText(p));
    if (contract) {
      const claimed = claimWithContract(db, ev, contract, session);
      if (claimed.ok) {
        track(
          record(
            db,
            baseObs(claimed.session, claimed.delegation, claimed.turn, "turn_started", {
              origin: "contract",
            }),
            null,
            null,
          ),
        );
        return out;
      }
      if (!session) return { ...out, status: "ignored", reason: claimed.reason };
    }
  }
  if (!session) return { ...out, status: "ignored", reason: "unregistered" };
  if (!isObservedWorker(db, session.id)) return { ...out, status: "ignored", reason: "not_a_worker" };

  switch (event) {
    case "SessionStart": {
      const source = str(p.source);
      db.query(
        "UPDATE sessions SET owner_generation = owner_generation + 1, bg_inventory = ?, updated_at = ? WHERE id = ?",
      ).run(source === "startup" ? "[]" : null, nowIso(), session.id);
      patchAdapterBinding(db, session.id, { process: null, processOwnerGeneration: null });
      track(record(db, baseObs(session, null, null, "owner_started", { source }), null, null));
      if (source === "resume") {
        // A resumed owner does not adopt the previous owner's background tasks (observed with Claude Code
        // 2.1.284 after the daemon respawned a killed owner): a wait armed by the bound turn can no longer
        // re-invoke the session, so a continuation it promised will not happen.
        const delegation = openDelegationForWorker(db, session.id);
        const turn = delegation ? latestTurn(db, delegation.request_id, session.generation) : null;
        if (delegation && turn?.state === "finished" && (turn.bg_running ?? 0) > 0) {
          if (turn.tracking === "lost") {
            // Already reported (for example by a probe during the respawn window); keep the loss permanent.
            if (turn.tracking_reason !== ORPHANED_BACKGROUND_REASON)
              updateTurn(db, turn.id, {
                tracking_reason: ORPHANED_BACKGROUND_REASON,
                evidence_at: ev.capturedAt,
              });
          } else {
            updateTurn(db, turn.id, {
              tracking: "lost",
              tracking_reason: ORPHANED_BACKGROUND_REASON,
              evidence_at: ev.capturedAt,
            });
            track(
              record(
                db,
                {
                  ...baseObs(session, delegation, turn, "tracking_lost", {
                    reason: ORPHANED_BACKGROUND_REASON,
                  }),
                  id: newId(),
                  occurrenceKey: `${occ}:orphaned_background`,
                },
                delegation,
                {
                  kind: "tracking_lost",
                  provider: "claude",
                  excerpt: ORPHANED_BACKGROUND_REASON,
                  label: "tracking lost",
                },
                noticeBlocker(db, delegation, turn, session),
              ),
            );
          }
        }
      }
      return out;
    }
    case "UserPromptSubmit":
      return onPrompt(db, ev, session, out, baseObs, track);
    case "Stop": {
      const running = runningTaskIds(p);
      // A delayed Stop must not overwrite the inventory a newer turn already observed.
      if (!newerTurnStarted(db, session.id, ev.capturedAt)) {
        db.query("UPDATE sessions SET bg_inventory = ?, updated_at = ? WHERE id = ?").run(
          running ? JSON.stringify(running) : null,
          nowIso(),
          session.id,
        );
      }
      session = getSession(db, session.id)!;
      const promptId = str(p.prompt_id);
      const turn = promptId ? turnByNative(db, session.id, promptId) : null;
      if (!turn) {
        track(record(db, baseObs(session, null, null, "turn_finished", { attributed: false }), null, null));
        return out;
      }
      const delegation = getDelegation(db, turn.delegation_id);
      const nextState = turn.state === "failed" || turn.state === "interrupted" ? turn.state : "finished";
      updateTurn(db, turn.id, {
        state: nextState,
        ended_at: ev.capturedAt,
        bg_running: running ? running.length : null,
        bg_task_ids: running ? JSON.stringify(running) : null,
        crons: typeof p.session_crons_count === "number" ? p.session_crons_count : null,
        evidence_at: ev.capturedAt,
        tracking: "ok",
        tracking_reason: null,
      });
      const lastText = str(p.last_assistant_message) ?? "";
      let blocker = noticeBlocker(db, delegation, turn, session);
      const explicit = blocker ? null : turnHasExplicitReport(db, turn.id);
      if (explicit) blocker = `explicit_report:${explicit}`;
      // A continuation (for example a timed-out wait re-arm) while the chain's question is still
      // unanswered adds nothing for the parent.
      if (!blocker && delegation) {
        const q = unresolvedQuestion(messagesInCorrelation(db, delegation.request_id), delegation);
        if (q?.turn_ref && chainOf(db, turn).some((t) => t.id === q.turn_ref))
          blocker = `awaiting_answer:${q.id}`;
      }
      const excerpt = lastText + backgroundNote(running);
      // A repeated Stop for the same prompt is recorded, but posts again only when the final text changed.
      if (!blocker && lastNoticeBody(db, turn.id, "turn_finished") === (excerpt || "(turn finished)")) {
        blocker = "repeated_stop";
      }
      track(
        record(
          db,
          baseObs(session, delegation, turn, "turn_finished", { backgroundRunning: running?.length ?? null }),
          delegation,
          {
            kind: "turn_finished",
            provider: "claude",
            excerpt,
            ...(ev.truncated?.last_assistant_message
              ? { capturedBytes: ev.truncated.last_assistant_message }
              : {}),
            label: running?.length ? "turn finished (background running)" : "turn finished",
          },
          blocker,
        ),
      );
      return out;
    }
    case "StopFailure": {
      const turn = turnFor(db, session, str(p.prompt_id));
      const delegation = turn ? getDelegation(db, turn.delegation_id) : null;
      if (turn)
        updateTurn(db, turn.id, { state: "failed", ended_at: ev.capturedAt, evidence_at: ev.capturedAt });
      const reason = [str(p.error_type), str(p.error_message)].filter(Boolean).join(": ") || "turn failed";
      track(
        record(
          db,
          baseObs(session, delegation, turn, "turn_failed", { errorType: str(p.error_type) }),
          delegation,
          { kind: "turn_failed", provider: "claude", excerpt: oneLine(reason, 1000), label: "turn failed" },
          noticeBlocker(db, delegation, turn, session),
        ),
      );
      return out;
    }
    case "PermissionRequest": {
      const turn = turnFor(db, session, str(p.prompt_id));
      const delegation = turn ? getDelegation(db, turn.delegation_id) : null;
      if (turn) updateTurn(db, turn.id, { permission_at: ev.capturedAt, evidence_at: ev.capturedAt });
      const summary = permissionSummary(p);
      track(
        record(
          db,
          baseObs(session, delegation, turn, "permission_request", { tool: str(p.tool_name) }),
          delegation,
          { kind: "permission_request", provider: "claude", excerpt: summary, label: "permission requested" },
          noticeBlocker(db, delegation, turn, session),
        ),
      );
      return out;
    }
    case "SessionEnd": {
      const candidates = db
        .query<TurnRow, [string, number, string]>(
          `SELECT * FROM turn_bindings WHERE session_id = ? AND generation = ?
             AND (state = 'active' OR (state = 'finished' AND coalesce(bg_running, 0) > 0))
             AND coalesce(started_at, created_at) <= ?`,
        )
        .all(session.id, session.generation, ev.capturedAt);
      const open = candidates.filter((t) => getDelegation(db, t.delegation_id)?.state === "open");
      if (open.length === 0) {
        track(
          record(db, baseObs(session, null, null, "owner_released", { reason: str(p.reason) }), null, null),
        );
        return out;
      }
      open.forEach((turn, i) => {
        const delegation = getDelegation(db, turn.delegation_id);
        const wasBackground = turn.state === "finished";
        updateTurn(db, turn.id, {
          state: "interrupted",
          ended_at: ev.capturedAt,
          evidence_at: ev.capturedAt,
        });
        const obs = baseObs(session!, delegation, turn, "turn_interrupted", {
          reason: str(p.reason),
          background: wasBackground,
        });
        if (i > 0) obs.id = `${ev.sourceEventId}:${i}`;
        track(
          record(
            db,
            obs,
            delegation,
            {
              kind: "turn_interrupted",
              provider: "claude",
              excerpt: wasBackground
                ? `Session ended (${str(p.reason) ?? "unknown reason"}) while delegated background work was still running`
                : `Session ended (${str(p.reason) ?? "unknown reason"}) during an open bound turn`,
              label: "turn interrupted",
            },
            noticeBlocker(db, delegation, turn, session!),
          ),
        );
      });
      return out;
    }
    default:
      return { ...out, status: "ignored", reason: "unsubscribed_event" };
  }
}

function backgroundNote(running: string[] | null): string {
  if (running === null) return "\n\n[agentbus: background task list unavailable]";
  if (running.length === 0) return "";
  return `\n\n[agentbus: ${running.length} background task(s) still running; Claude will take another turn when they finish]`;
}

/**
 * Background tasks that existed before a contract turn: the last known inventory, or none when no owner
 * start was observed yet (a freshly launched worker whose first prompt is the contract).
 */
function contractBaseline(session: SessionRow): string[] | null {
  if (session.bg_inventory) return JSON.parse(session.bg_inventory);
  return session.owner_generation === 0 ? [] : null;
}

/** Exact prompt attribution when the payload names one; otherwise the current generation's active turn. */
function turnFor(db: Db, session: SessionRow, promptId: string | null): TurnRow | null {
  if (promptId) return turnByNative(db, session.id, promptId);
  return activeTurnForSession(db, session.id, session.generation);
}

/** True when a turn of this session started after `capturedAt`: older events cannot rebind it. */
function newerTurnStarted(db: Db, sessionId: string, capturedAt: string): boolean {
  return !!db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM turn_bindings WHERE session_id = ? AND coalesce(started_at, created_at) > ? LIMIT 1",
    )
    .get(sessionId, capturedAt);
}

/** The continuation chain ending at `turn`, newest first. */
function chainOf(db: Db, turn: TurnRow): TurnRow[] {
  const chain: TurnRow[] = [];
  for (
    let t: TurnRow | null = turn;
    t && chain.length < 1000;
    t = t.predecessor_id ? getTurn(db, t.predecessor_id) : null
  ) {
    chain.push(t);
  }
  return chain;
}

type ClaimOutcome =
  | { ok: true; session: SessionRow; delegation: DelegationRow; turn: TurnRow }
  | { ok: false; reason: string };

/** The first contract-bearing prompt claims its pending worker after full database validation. */
function claimWithContract(
  db: Db,
  ev: CapturedClaudeEvent,
  contract: NonNullable<ReturnType<typeof parseContract>>,
  current: SessionRow | null,
): ClaimOutcome {
  const p = ev.payload;
  const nativeSid = str(p.session_id)!;
  const promptId = str(p.prompt_id);
  if (contract.provider !== "claude") return { ok: false, reason: "contract_provider_mismatch" };
  const delegation = getDelegation(db, contract.requestId);
  if (delegation?.state !== "open") return { ok: false, reason: "contract_delegation_not_open" };
  if (delegation.worker_id !== contract.workerId) return { ok: false, reason: "contract_worker_mismatch" };
  const worker = getSession(db, contract.workerId);
  if (worker?.provider !== "claude") return { ok: false, reason: "contract_worker_invalid" };
  if (current && current.id !== worker.id) return { ok: false, reason: "session_registered_elsewhere" };
  if (worker.external_id && worker.external_id !== nativeSid)
    return { ok: false, reason: "worker_bound_elsewhere" };
  const cwd = str(p.cwd);
  if (worker.cwd_real && (!cwd || realOrSelf(cwd) !== worker.cwd_real))
    return { ok: false, reason: "cwd_mismatch" };
  if (promptId && turnByNative(db, worker.id, promptId)) return { ok: false, reason: "prompt_already_bound" };
  if (newerTurnStarted(db, worker.id, ev.capturedAt)) return { ok: false, reason: "delayed_claim" };

  const now = nowIso();
  if (!worker.external_id) {
    db.query("UPDATE sessions SET external_id = ?, bound_at = ?, updated_at = ? WHERE id = ?").run(
      nativeSid,
      now,
      now,
      worker.id,
    );
  }
  db.query("UPDATE sessions SET generation = generation + 1, updated_at = ? WHERE id = ?").run(
    now,
    worker.id,
  );
  const session = getSession(db, worker.id)!;
  const turn = insertTurn(db, {
    delegationId: delegation.request_id,
    sessionId: session.id,
    generation: session.generation,
    ownerGeneration: session.owner_generation,
    kind: "claude_prompt",
    origin: "contract",
    nativeTurnId: promptId,
    runId: null,
    predecessorId: null,
    state: "active",
    startedAt: ev.capturedAt,
    bgBaseline: contractBaseline(session),
  });
  updateTurn(db, turn.id, { evidence_at: ev.capturedAt });
  return { ok: true, session, delegation, turn: getTurn(db, turn.id)! };
}

function onPrompt(
  db: Db,
  ev: CapturedClaudeEvent,
  session: SessionRow,
  out: IngestResult,
  baseObs: (
    s: SessionRow,
    d: DelegationRow | null,
    t: TurnRow | null,
    kind: string,
    detail?: Record<string, unknown>,
  ) => Parameters<typeof record>[1],
  track: (r: { observationId: string; noticeId: string | null }) => void,
): IngestResult {
  const p = ev.payload;
  const promptId = str(p.prompt_id);
  const notification = parseTaskNotification(promptText(p));
  if (newerTurnStarted(db, session.id, ev.capturedAt)) {
    // A delayed prompt is recorded for history but can neither continue nor supersede newer bindings.
    track(
      record(db, baseObs(session, null, null, "prompt_stale", { notification: !!notification }), null, null),
    );
    return out;
  }
  const predecessor = notification ? continuationSource(db, ev, session, notification) : null;
  if (predecessor) {
    const delegation = getDelegation(db, predecessor.delegation_id)!;
    if (predecessor.state === "active") {
      updateTurn(db, predecessor.id, { state: "finished", ended_at: ev.capturedAt });
    }
    const turn = insertTurn(db, {
      delegationId: predecessor.delegation_id,
      sessionId: session.id,
      generation: predecessor.generation,
      ownerGeneration: session.owner_generation,
      kind: "claude_prompt",
      origin: "continuation",
      nativeTurnId: promptId,
      runId: null,
      predecessorId: predecessor.id,
      state: "active",
      startedAt: ev.capturedAt,
      bgBaseline: session.bg_inventory ? JSON.parse(session.bg_inventory) : null,
    });
    updateTurn(db, turn.id, { evidence_at: ev.capturedAt });
    track(
      record(
        db,
        baseObs(session, delegation, turn, "turn_started", {
          origin: "continuation",
          taskId: notification!.taskId,
        }),
        null,
        null,
      ),
    );
    return out;
  }

  // Any other prompt ends automatic inheritance of the binding; old turn records stay for late events.
  const delegation = openDelegationForWorker(db, session.id);
  const bound = delegation ? latestTurn(db, delegation.request_id, session.generation) : null;
  if (delegation && bound) {
    db.query("UPDATE sessions SET generation = generation + 1, updated_at = ? WHERE id = ?").run(
      nowIso(),
      session.id,
    );
    const reason = notification
      ? "a background-task notification without proven delegation provenance started a new turn"
      : "an unrelated prompt (for example a manual follow-up) started a new turn in the worker session";
    track(
      record(
        db,
        baseObs(session, delegation, bound, "tracking_lost", {
          reason: "superseded",
          notification: !!notification,
        }),
        delegation,
        {
          kind: "tracking_lost",
          provider: "claude",
          excerpt: `${reason}; later activity is not attributed to this delegation`,
          label: "tracking lost",
        },
      ),
    );
    return out;
  }
  track(
    record(db, baseObs(session, null, null, "prompt_unbound", { notification: !!notification }), null, null),
  );
  return out;
}

/**
 * A task notification continues a bound turn only with proven provenance: a verified Agentbus wait arm
 * captured from that turn, or a task that first appeared in that turn's own Stop inventory against a
 * known baseline. The originating turn must still be in the session's current binding generation.
 */
function continuationSource(
  db: Db,
  ev: CapturedClaudeEvent,
  session: SessionRow,
  n: TaskNotification,
): TurnRow | null {
  const delegation = openDelegationForWorker(db, session.id);
  if (!delegation) return null;
  const head = latestTurn(db, delegation.request_id, session.generation);
  if (!head) return null;
  const chain = chainOf(db, head);
  const origin = ev.waitOrigin;
  if (origin) {
    const arm = getWaitArm(db, origin.armId);
    if (!arm || arm.session_id !== session.id || !arm.turn_ref || arm.turn_ref !== origin.turnRef)
      return null;
    return chain.some((t) => t.id === arm.turn_ref) ? head : null;
  }
  const createdInChain = chain.some((t) => {
    if (!t.bg_task_ids || t.bg_baseline === null) return false;
    const baseline = JSON.parse(t.bg_baseline) as string[];
    return (JSON.parse(t.bg_task_ids) as string[]).some((id) => id === n.taskId && !baseline.includes(id));
  });
  return createdInChain ? head : null;
}
