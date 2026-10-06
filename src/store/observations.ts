import { newId, nowIso } from "../util/misc.ts";
import type { Db } from "./db.ts";

export type TurnState = "prepared" | "active" | "finished" | "failed" | "interrupted";

export interface TurnRow {
  id: string;
  delegation_id: string;
  session_id: string;
  generation: number;
  owner_generation: number | null;
  kind: "claude_prompt" | "codex_run";
  origin: "contract" | "continuation" | "runner";
  native_turn_id: string | null;
  run_id: string | null;
  predecessor_id: string | null;
  state: TurnState;
  tracking: "ok" | "lost";
  tracking_reason: string | null;
  bg_running: number | null;
  bg_task_ids: string | null;
  bg_baseline: string | null;
  crons: number | null;
  permission_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  evidence_at: string;
  created_at: string;
}

export function getTurn(db: Db, id: string): TurnRow | null {
  return db.query<TurnRow, [string]>("SELECT * FROM turn_bindings WHERE id = ?").get(id);
}

export function turnByNative(db: Db, sessionId: string, nativeTurnId: string): TurnRow | null {
  return db
    .query<TurnRow, [string, string]>(
      "SELECT * FROM turn_bindings WHERE session_id = ? AND native_turn_id = ?",
    )
    .get(sessionId, nativeTurnId);
}

export function turnByRun(db: Db, runId: string): TurnRow | null {
  return db.query<TurnRow, [string]>("SELECT * FROM turn_bindings WHERE run_id = ?").get(runId);
}

/** Latest turn of a delegation, optionally restricted to one binding generation. */
export function latestTurn(db: Db, delegationId: string, generation?: number): TurnRow | null {
  if (generation === undefined) {
    return db
      .query<TurnRow, [string]>(
        "SELECT * FROM turn_bindings WHERE delegation_id = ? ORDER BY generation DESC, created_at DESC, rowid DESC LIMIT 1",
      )
      .get(delegationId);
  }
  return db
    .query<TurnRow, [string, number]>(
      "SELECT * FROM turn_bindings WHERE delegation_id = ? AND generation = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(delegationId, generation);
}

/** The session's current active turn in its current generation: the attribution target for task replies. */
export function activeTurnForSession(db: Db, sessionId: string, generation: number): TurnRow | null {
  return db
    .query<TurnRow, [string, number]>(
      `SELECT * FROM turn_bindings WHERE session_id = ? AND generation = ? AND state = 'active'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionId, generation);
}

export function hasSuccessor(db: Db, turnId: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM turn_bindings WHERE predecessor_id = ?")
      .get(turnId)!.n > 0
  );
}

export interface InsertTurn {
  delegationId: string;
  sessionId: string;
  generation: number;
  ownerGeneration: number | null;
  kind: TurnRow["kind"];
  origin: TurnRow["origin"];
  nativeTurnId: string | null;
  runId: string | null;
  predecessorId: string | null;
  state: TurnState;
  startedAt: string | null;
  bgBaseline: string[] | null;
}

export function insertTurn(db: Db, t: InsertTurn): TurnRow {
  const id = newId();
  const now = nowIso();
  db.query(
    `INSERT INTO turn_bindings (id, delegation_id, session_id, generation, owner_generation, kind, origin,
       native_turn_id, run_id, predecessor_id, state, started_at, bg_baseline, evidence_at, created_at)
     VALUES ($id, $d, $s, $g, $og, $kind, $origin, $native, $run, $pred, $state, $started, $baseline, $now, $now)`,
  ).run({
    id,
    d: t.delegationId,
    s: t.sessionId,
    g: t.generation,
    og: t.ownerGeneration,
    kind: t.kind,
    origin: t.origin,
    native: t.nativeTurnId,
    run: t.runId,
    pred: t.predecessorId,
    state: t.state,
    started: t.startedAt,
    baseline: t.bgBaseline ? JSON.stringify(t.bgBaseline) : null,
    now,
  });
  return getTurn(db, id)!;
}

export function updateTurn(db: Db, id: string, patch: Partial<Omit<TurnRow, "id">>): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = $${k}`).join(", ");
  const params: Record<string, string | number | null> = { id };
  for (const k of keys) params[k] = (patch[k] ?? null) as string | number | null;
  db.query(`UPDATE turn_bindings SET ${sets} WHERE id = $id`).run(params);
}

export interface ObservationRow {
  id: string;
  occurrence_key: string | null;
  session_id: string | null;
  delegation_id: string | null;
  turn_ref: string | null;
  generation: number | null;
  source: "claude-hook" | "codex-runner" | "probe";
  kind: string;
  native_event: string | null;
  native_turn_id: string | null;
  captured_at: string;
  ingested_at: string;
  detail: string;
  notice_id: string | null;
  suppressed_by: string | null;
}

export function observationExists(db: Db, id: string, occurrenceKey: string | null): ObservationRow | null {
  const byId = db.query<ObservationRow, [string]>("SELECT * FROM observations WHERE id = ?").get(id);
  if (byId) return byId;
  if (!occurrenceKey) return null;
  return db
    .query<ObservationRow, [string]>("SELECT * FROM observations WHERE occurrence_key = ?")
    .get(occurrenceKey);
}

/** The probe's record that the worker session ended before its first bound turn in this binding generation. */
export function launchFailure(db: Db, delegationId: string, generation: number): ObservationRow | null {
  return db
    .query<ObservationRow, [string, number]>(
      "SELECT * FROM observations WHERE delegation_id = ? AND generation = ? AND kind = 'launch_failed' ORDER BY captured_at DESC, rowid DESC LIMIT 1",
    )
    .get(delegationId, generation);
}

export interface InsertObservation {
  id: string;
  occurrenceKey: string | null;
  sessionId: string | null;
  delegationId: string | null;
  turnRef: string | null;
  generation: number | null;
  source: ObservationRow["source"];
  kind: string;
  nativeEvent: string | null;
  nativeTurnId: string | null;
  capturedAt: string;
  detail: Record<string, unknown>;
  noticeId: string | null;
  suppressedBy: string | null;
}

export function insertObservation(db: Db, o: InsertObservation): void {
  db.query(
    `INSERT INTO observations (id, occurrence_key, session_id, delegation_id, turn_ref, generation, source, kind,
       native_event, native_turn_id, captured_at, ingested_at, detail, notice_id, suppressed_by)
     VALUES ($id, $occ, $s, $d, $t, $g, $source, $kind, $ne, $nt, $cap, $ing, $detail, $notice, $supp)`,
  ).run({
    id: o.id,
    occ: o.occurrenceKey,
    s: o.sessionId,
    d: o.delegationId,
    t: o.turnRef,
    g: o.generation,
    source: o.source,
    kind: o.kind,
    ne: o.nativeEvent,
    nt: o.nativeTurnId,
    cap: o.capturedAt,
    ing: nowIso(),
    detail: JSON.stringify(o.detail),
    notice: o.noticeId,
    supp: o.suppressedBy,
  });
}

export function observationsForSession(db: Db, sessionId: string, limit: number): ObservationRow[] {
  return db
    .query<ObservationRow, [string, number]>(
      "SELECT * FROM observations WHERE session_id = ? ORDER BY captured_at DESC, rowid DESC LIMIT ?",
    )
    .all(sessionId, limit);
}

/** What a wait delivers: everything, one request, a --settled snapshot, or a --from/--type subset. */
export type WaitScope = "all" | "correlation" | "settled" | "filtered";

export interface WaitArmRow {
  id: string;
  session_id: string;
  delegation_id: string | null;
  turn_ref: string | null;
  correlation: string | null;
  created_at: string;
  ended_at: string | null;
  end_reason: string | null;
  /** NULL for arms recorded before migration 6: coverage and owner unknown. */
  scope: WaitScope | null;
  /** JSON ProcessIdentity of the wait process. */
  process: string | null;
  /** JSON ProcessIdentity[] of its nearest ancestors when armed. */
  owner: string | null;
  expires_at: string | null;
}

export interface InsertWaitArm {
  sessionId: string;
  delegationId: string | null;
  turnRef: string | null;
  correlation: string | null;
  scope: WaitScope;
  process: unknown;
  owner: unknown;
  expiresAt: string;
}

export function insertWaitArm(db: Db, arm: InsertWaitArm): WaitArmRow {
  const id = newId();
  db.query(
    `INSERT INTO wait_arms (id, session_id, delegation_id, turn_ref, correlation, created_at, scope, process, owner,
       expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    arm.sessionId,
    arm.delegationId,
    arm.turnRef,
    arm.correlation,
    nowIso(),
    arm.scope,
    arm.process ? JSON.stringify(arm.process) : null,
    arm.owner ? JSON.stringify(arm.owner) : null,
    arm.expiresAt,
  );
  return db.query<WaitArmRow, [string]>("SELECT * FROM wait_arms WHERE id = ?").get(id)!;
}

/** Unended arms of a session, newest first. */
export function openWaitArms(db: Db, sessionId: string): WaitArmRow[] {
  return db
    .query<WaitArmRow, [string]>(
      "SELECT * FROM wait_arms WHERE session_id = ? AND ended_at IS NULL ORDER BY created_at DESC, rowid DESC",
    )
    .all(sessionId);
}

/** The session's most recent arms, newest first. */
export function recentWaitArms(db: Db, sessionId: string, limit: number): WaitArmRow[] {
  return db
    .query<WaitArmRow, [string, number]>(
      "SELECT * FROM wait_arms WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .all(sessionId, limit);
}

/** Arms of a session created or ended within [from, to], or still running across `from`, oldest first. */
export function waitArmsBetween(db: Db, sessionId: string, fromIso: string, toIso: string): WaitArmRow[] {
  return db
    .query<WaitArmRow, [Record<string, string>]>(
      `SELECT * FROM wait_arms WHERE session_id = $session
         AND ((created_at BETWEEN $from AND $to) OR (ended_at BETWEEN $from AND $to)
           OR (created_at < $from AND (ended_at IS NULL OR ended_at > $from)))
       ORDER BY created_at, rowid`,
    )
    .all({ session: sessionId, from: fromIso, to: toIso });
}

export function getWaitArm(db: Db, id: string): WaitArmRow | null {
  return db.query<WaitArmRow, [string]>("SELECT * FROM wait_arms WHERE id = ?").get(id);
}

/** Retires every other unfinished wait of the session; each notices it on its next poll. */
export function supersedeWaitArms(db: Db, sessionId: string, exceptId: string): number {
  return db
    .query(
      "UPDATE wait_arms SET ended_at = ?, end_reason = 'superseded' WHERE session_id = ? AND id <> ? AND ended_at IS NULL",
    )
    .run(nowIso(), sessionId, exceptId).changes;
}

export function endWaitArm(db: Db, id: string, reason: string): void {
  db.query("UPDATE wait_arms SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL").run(
    nowIso(),
    reason,
    id,
  );
}

/**
 * Evidence about one delegation, oldest first: observations attributed to it, plus its worker's
 * session-level observations (owner starts and releases, unattributed prompts) from `fromIso` until `toIso`.
 */
export function observationsForDelegation(
  db: Db,
  delegationId: string,
  workerId: string,
  fromIso: string,
  toIso: string,
): ObservationRow[] {
  return db
    .query<ObservationRow, [string, string, string, string]>(
      `SELECT * FROM observations
        WHERE delegation_id = ?
           OR (session_id = ? AND delegation_id IS NULL AND captured_at >= ? AND captured_at < ?)
        ORDER BY captured_at, rowid`,
    )
    .all(delegationId, workerId, fromIso, toIso);
}
