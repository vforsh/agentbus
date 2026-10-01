// Codex runner events: the runner owning a `codex exec` run reports normalized, replayable events.

import { z } from "zod";
import { conflict, inputError } from "../../errors.ts";
import { noticeBlocker, record, turnHasExplicitReport } from "../../services/observe.ts";
import { type Db, tx } from "../../store/db.ts";
import { getDelegation } from "../../store/delegations.ts";
import {
  insertTurn,
  latestTurn,
  observationExists,
  type TurnRow,
  turnByRun,
  updateTurn,
} from "../../store/observations.ts";
import { bindSession, getSession, patchAdapterBinding, type SessionRow } from "../../store/sessions.ts";
import { nowIso, oneLine } from "../../util/misc.ts";

const Identity = z.object({ pid: z.number().int().positive(), start: z.string().min(1) }).strict();

export const RunnerEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.uuid(),
    runId: z.uuid(),
    ordinal: z.number().int().nonnegative(),
    workerId: z.uuid(),
    requestId: z.uuid(),
    kind: z.enum(["run_started", "child_started", "thread_started", "turn_started", "run_finished"]),
    capturedAt: z.iso.datetime(),
    runDir: z.string().optional(),
    resumeThreadId: z.uuid().nullable().optional(),
    threadId: z.uuid().optional(),
    nativeTurnId: z.string().max(200).nullable().optional(),
    runner: Identity.optional(),
    child: Identity.optional(),
    exit: z.object({ code: z.number().int().nullable(), signal: z.string().nullable() }).strict().optional(),
    turnCompleted: z.boolean().optional(),
    finalMessage: z.string().nullable().optional(),
    finalMessageFresh: z.boolean().optional(),
    error: z.string().max(4000).nullable().optional(),
  })
  .strict();

export type RunnerEvent = z.infer<typeof RunnerEventSchema>;

export interface RunnerIngestResult {
  status: "ingested" | "duplicate";
  observationId: string;
  noticeId: string | null;
  turnRef: string | null;
  classification?: "turn_finished" | "turn_failed" | "turn_interrupted";
}

const RUN_OUTCOMES = {
  turn_finished: { state: "finished", label: "turn finished" },
  turn_failed: { state: "failed", label: "turn failed" },
  turn_interrupted: { state: "interrupted", label: "turn interrupted" },
} as const;

export function parseRunnerEvent(raw: unknown): RunnerEvent {
  const parsed = RunnerEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw inputError("invalid_runner_event", `Invalid runner event: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Classifies a finished run; stale or missing completion evidence is a failure, never a result. */
export function classifyRun(ev: RunnerEvent): {
  kind: "turn_finished" | "turn_failed" | "turn_interrupted";
  reason: string;
} {
  if (ev.exit?.signal)
    return { kind: "turn_interrupted", reason: `codex exec ended by signal ${ev.exit.signal}` };
  if (ev.error) return { kind: "turn_failed", reason: ev.error };
  if (ev.exit?.code !== 0)
    return { kind: "turn_failed", reason: `codex exec exited with status ${ev.exit?.code ?? "unknown"}` };
  if (!ev.turnCompleted) return { kind: "turn_failed", reason: "no turn.completed event was observed" };
  if (!ev.finalMessageFresh || ev.finalMessage === null || ev.finalMessage === undefined) {
    return { kind: "turn_failed", reason: "the run produced no fresh final message" };
  }
  return { kind: "turn_finished", reason: "turn completed" };
}

export function ingestRunnerEvent(db: Db, ev: RunnerEvent): RunnerIngestResult {
  return tx(db, () => {
    const occ = `codex:run:${ev.runId}:${ev.ordinal}`;
    const existing = observationExists(db, ev.eventId, occ);
    if (existing) {
      return {
        status: "duplicate",
        observationId: existing.id,
        noticeId: existing.notice_id,
        turnRef: existing.turn_ref,
      };
    }
    let worker = getSession(db, ev.workerId);
    if (worker?.provider !== "codex") {
      throw inputError("invalid_runner_event", `Worker ${ev.workerId} is not a registered Codex session`);
    }
    const delegation = getDelegation(db, ev.requestId);
    if (!delegation || delegation.worker_id !== worker.id) {
      throw conflict("wrong_role", `Request ${ev.requestId} is not delegated to worker ${ev.workerId}`);
    }
    let turn = turnByRun(db, ev.runId);
    const obs = (kind: string, t: TurnRow | null, detail: Record<string, unknown> = {}) => ({
      id: ev.eventId,
      occurrenceKey: occ,
      sessionId: worker!.id,
      delegationId: delegation.request_id,
      turnRef: t?.id ?? null,
      generation: t?.generation ?? worker!.generation,
      source: "codex-runner" as const,
      kind,
      nativeEvent: ev.kind,
      nativeTurnId: ev.nativeTurnId ?? null,
      capturedAt: ev.capturedAt,
      detail: { runId: ev.runId, ordinal: ev.ordinal, ...detail },
    });
    const done = (r: { observationId: string; noticeId: string | null }, t: TurnRow | null, extra = {}) => ({
      status: "ingested" as const,
      ...r,
      turnRef: t?.id ?? null,
      ...extra,
    });

    if (ev.kind === "run_started") {
      if (turn) return done(record(db, obs("run_started", turn, { replay: true }), null, null), turn);
      if (delegation.state !== "open") {
        throw conflict(
          "delegation_closed",
          `Delegation ${delegation.request_id} is ${delegation.state}; no new run may bind to it`,
        );
      }
      // One managed run at a time: a resume waits until the prior run has reconciled its outcome.
      const prior = latestTurn(db, delegation.request_id);
      if (prior && (prior.state === "prepared" || prior.state === "active")) {
        throw conflict(
          "run_active",
          `Run ${prior.run_id} has not reported its outcome; it still owns the thread`,
          {
            runId: prior.run_id,
          },
        );
      }
      if (ev.resumeThreadId && worker.external_id && ev.resumeThreadId !== worker.external_id) {
        throw conflict(
          "binding_conflict",
          `Resume target ${ev.resumeThreadId} is not worker thread ${worker.external_id}`,
        );
      }
      db.query("UPDATE sessions SET generation = generation + 1, updated_at = ? WHERE id = ?").run(
        nowIso(),
        worker.id,
      );
      worker = getSession(db, worker.id)!;
      turn = insertTurn(db, {
        delegationId: delegation.request_id,
        sessionId: worker.id,
        generation: worker.generation,
        ownerGeneration: null,
        kind: "codex_run",
        origin: "runner",
        nativeTurnId: null,
        runId: ev.runId,
        predecessorId: null,
        state: "prepared",
        startedAt: null,
        bgBaseline: null,
      });
      updateTurn(db, turn.id, { evidence_at: ev.capturedAt });
      patchAdapterBinding(db, worker.id, {
        runId: ev.runId,
        runDir: ev.runDir ?? null,
        runner: ev.runner ?? null,
        child: null,
        generation: worker.generation,
      });
      return done(record(db, obs("run_started", turn), null, null), turn);
    }

    if (!turn) throw conflict("unknown_run", `Run ${ev.runId} was never started for this delegation`);

    switch (ev.kind) {
      case "child_started": {
        if (ev.child) patchCurrentRun(db, worker, ev.runId, { child: ev.child });
        updateTurn(db, turn.id, { evidence_at: ev.capturedAt });
        return done(record(db, obs("child_started", turn), null, null), turn);
      }
      case "thread_started": {
        if (!ev.threadId) throw inputError("invalid_runner_event", "thread_started requires threadId");
        if (ev.resumeThreadId && ev.threadId !== ev.resumeThreadId) {
          throw conflict(
            "binding_conflict",
            `Resumed run reported thread ${ev.threadId}, expected ${ev.resumeThreadId}`,
          );
        }
        bindSession(db, worker, ev.threadId, {});
        return done(record(db, obs("thread_started", turn, { threadId: ev.threadId }), null, null), turn);
      }
      case "turn_started": {
        updateTurn(db, turn.id, {
          state: turn.state === "prepared" ? "active" : turn.state,
          started_at: turn.started_at ?? ev.capturedAt,
          native_turn_id: ev.nativeTurnId ?? turn.native_turn_id,
          evidence_at: ev.capturedAt,
          tracking: "ok",
          tracking_reason: null,
        });
        return done(record(db, obs("turn_started", turn), null, null), turn);
      }
      case "run_finished": {
        const c = classifyRun(ev);
        const { state, label } = RUN_OUTCOMES[c.kind];
        updateTurn(db, turn.id, {
          state,
          ended_at: ev.capturedAt,
          evidence_at: ev.capturedAt,
          bg_running: 0,
          tracking: "ok",
          tracking_reason: null,
        });
        worker = getSession(db, worker.id)!;
        const fresh = getDelegation(db, delegation.request_id);
        let blocker = noticeBlocker(db, fresh, turn, worker);
        if (!blocker && c.kind === "turn_finished") {
          const explicit = turnHasExplicitReport(db, turn.id);
          if (explicit) blocker = `explicit_report:${explicit}`;
        }
        const excerpt = c.kind === "turn_finished" ? (ev.finalMessage ?? "") : oneLine(c.reason, 2000);
        const r = record(
          db,
          obs(c.kind, turn, {
            exit: ev.exit ?? null,
            turnCompleted: ev.turnCompleted ?? null,
            reason: c.reason,
          }),
          fresh,
          { kind: c.kind, provider: "codex", excerpt, label },
          blocker,
        );
        return done(r, turn, { classification: c.kind });
      }
    }
    throw inputError("invalid_runner_event", `Unsupported runner event kind ${ev.kind}`);
  });
}

function patchCurrentRun(db: Db, worker: SessionRow, runId: string, patch: Record<string, unknown>): void {
  const binding = JSON.parse(worker.adapter_binding) as Record<string, unknown>;
  // Only the current run may update process identities; a late event from an older run cannot.
  if (binding.runId === runId) patchAdapterBinding(db, worker.id, patch);
}
