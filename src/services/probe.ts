// Liveness probes for open delegations. Unknown stays unknown: a failed or missing probe yields tracking
// loss, never interruption; only a positively ended process (PID plus start identity) interrupts a turn.

import {
  type AgentRow,
  claudeInventory,
  type Inventory,
  ownerOf,
  readJobState,
} from "../adapters/claude/probe.ts";
import { identify, type Liveness, liveness, type ProcessIdentity } from "../adapters/process.ts";
import type { Resolved } from "../config/config.ts";
import { type Db, tx } from "../store/db.ts";
import { type DelegationRow, getDelegation } from "../store/delegations.ts";
import { getTurn, latestTurn, type TurnRow, updateTurn } from "../store/observations.ts";
import { getSession, patchAdapterBinding, type SessionRow } from "../store/sessions.ts";
import { newId, nowIso } from "../util/misc.ts";
import { noticeBlocker, ORPHANED_BACKGROUND_REASON, record } from "./observe.ts";

export interface ProbeReport {
  requestId: string;
  workerId: string;
  provider: string;
  evidence: "alive" | "confirmed_dead" | "tracking_lost" | "not_tracked" | "unbound" | "probe_failed";
  activity: "running" | "awaiting_input" | "idle" | "stopped" | "unknown";
  owner: "background" | "desktop" | "exec" | "interactive" | "unknown";
  reason: string;
  observedAt: string;
  detail?: string | null;
  needs?: unknown;
  noticeId?: string | null;
}

/** Turns whose activity matters: active, prepared, or ended with delegated background work running. */
const needsTracking = (t: TurnRow): boolean =>
  t.state === "active" || t.state === "prepared" || (t.state === "finished" && (t.bg_running ?? 0) > 0);

export function probeDelegations(
  db: Db,
  paths: Resolved,
  delegations: DelegationRow[],
  opts: { deadline: number; diagnostics?: boolean },
): ProbeReport[] {
  const open = delegations.filter((d) => d.state === "open");
  const reports: ProbeReport[] = [];
  let inventory: Inventory | null = null;
  for (const d of open) {
    const worker = getSession(db, d.worker_id);
    if (!worker) continue;
    const observedAt = nowIso();
    const base = { requestId: d.request_id, workerId: worker.id, provider: worker.provider, observedAt };
    if (!worker.external_id) {
      reports.push({
        ...base,
        evidence: "unbound",
        activity: "unknown",
        owner: "unknown",
        reason: "worker not yet bound",
      });
      continue;
    }
    if (worker.provider === "claude") {
      inventory ??= claudeInventory(paths.claudeBin, Math.min(10_000, opts.deadline - Date.now()));
      reports.push(probeClaude(db, paths, d, worker, inventory, observedAt, opts.diagnostics ?? false));
    } else if (worker.provider === "codex") {
      reports.push(probeCodex(db, d, worker, observedAt));
    } else {
      reports.push({
        ...base,
        evidence: "not_tracked",
        activity: "unknown",
        owner: "unknown",
        reason: "generic workers have no adapter",
      });
    }
  }
  return reports;
}

function probeClaude(
  db: Db,
  paths: Resolved,
  d: DelegationRow,
  worker: SessionRow,
  inv: Inventory,
  observedAt: string,
  diagnostics: boolean,
): ProbeReport {
  const base = { requestId: d.request_id, workerId: worker.id, provider: "claude", observedAt };
  const turn = latestTurn(db, d.request_id, worker.generation);
  const binding = JSON.parse(worker.adapter_binding) as Record<string, unknown>;
  if (!inv.ok) {
    const noticeId =
      turn && needsTracking(turn)
        ? markTrackingLost(db, d, worker, turn, `probe failed: ${inv.error}`)
        : null;
    return {
      ...base,
      evidence: "probe_failed",
      activity: "unknown",
      owner: "unknown",
      reason: inv.error,
      noticeId,
    };
  }
  const rows = inv.rows.filter((r) => r.sessionId === worker.external_id);
  const live = rows.map((r) => ({ row: r, id: r.pid ? identify(r.pid) : null })).find((x) => x.id !== null);
  const shortId =
    rows.find((r) => r.id)?.id ?? (typeof binding.shortId === "string" ? binding.shortId : null);
  const jobs = diagnostics ? readJobState(paths.claudeJobsDir, shortId) : null;
  const enrich = jobs ? { detail: jobs.detail, needs: jobs.needs } : {};

  if (live) {
    tx(db, () =>
      patchAdapterBinding(db, worker.id, {
        shortId,
        process: live.id,
        processOwnerGeneration: worker.owner_generation,
        owner: ownerOf(live.row.kind),
        probedAt: observedAt,
      }),
    );
    if (turn?.tracking === "lost") restoreTracking(db, worker, turn);
    return {
      ...base,
      evidence: "alive",
      activity: activityOf(live.row),
      owner: ownerOf(live.row.kind),
      reason: `live ${live.row.kind ?? "unknown"} owner pid ${live.row.pid}`,
      ...enrich,
    };
  }
  // Death counts only for the owner observed in the current owner generation, and only while the
  // inventory still lists the session: a missing row is tracking loss, never an interruption.
  const recorded =
    binding.processOwnerGeneration === worker.owner_generation
      ? (binding.process as ProcessIdentity | null | undefined)
      : undefined;
  const life: Liveness = rows.length > 0 ? liveness(recorded) : "unknown";
  if (!turn || !needsTracking(turn)) {
    return {
      ...base,
      evidence: "not_tracked",
      activity: rows.length > 0 ? "stopped" : "unknown",
      owner: "unknown",
      reason: "no live owner; no tracked activity outstanding",
      ...enrich,
    };
  }
  if (life === "dead") {
    const noticeId = interrupt(
      db,
      d,
      worker,
      turn,
      `worker process ${recorded!.pid} ended without a terminal hook event`,
    );
    return {
      ...base,
      evidence: "confirmed_dead",
      activity: "stopped",
      owner: "unknown",
      reason: "recorded owner process ended",
      noticeId,
      ...enrich,
    };
  }
  const reason =
    rows.length === 0
      ? "no claude agents row for the worker session"
      : "no live owner process could be verified";
  const noticeId = markTrackingLost(db, d, worker, turn, reason);
  return {
    ...base,
    evidence: "tracking_lost",
    activity: "unknown",
    owner: "unknown",
    reason,
    noticeId,
    ...enrich,
  };
}

function activityOf(row: AgentRow): ProbeReport["activity"] {
  if (row.status === "idle") return "idle";
  if (row.status === "waiting" || row.status === "awaiting_input") return "awaiting_input";
  if (row.status) return "running";
  return "unknown";
}

function probeCodex(db: Db, d: DelegationRow, worker: SessionRow, observedAt: string): ProbeReport {
  const base = { requestId: d.request_id, workerId: worker.id, provider: "codex", observedAt };
  const turn = latestTurn(db, d.request_id, worker.generation);
  const binding = JSON.parse(worker.adapter_binding) as Record<string, unknown>;
  if (!turn || !needsTracking(turn)) {
    return {
      ...base,
      evidence: "not_tracked",
      activity: turn ? "idle" : "unknown",
      owner: "unknown",
      reason: "no managed run outstanding",
    };
  }
  if (binding.runId !== turn.run_id) {
    const noticeId = markTrackingLost(
      db,
      d,
      worker,
      turn,
      "runner identity for the current run was never recorded",
    );
    return {
      ...base,
      evidence: "tracking_lost",
      activity: "unknown",
      owner: "exec",
      reason: "no runner identity",
      noticeId,
    };
  }
  const runner = liveness(binding.runner as ProcessIdentity | undefined);
  const child = liveness(binding.child as ProcessIdentity | undefined);
  if (runner === "alive") {
    if (turn.tracking === "lost") restoreTracking(db, worker, turn);
    return {
      ...base,
      evidence: "alive",
      activity: "running",
      owner: "exec",
      reason: `runner alive, child ${child}`,
    };
  }
  if (runner === "dead" && child === "dead") {
    const noticeId = interrupt(
      db,
      d,
      worker,
      turn,
      "codex runner and exec child ended without a terminal runner event",
    );
    return {
      ...base,
      evidence: "confirmed_dead",
      activity: "stopped",
      owner: "exec",
      reason: "runner and child ended",
      noticeId,
    };
  }
  const reason =
    runner === "dead" && child === "alive"
      ? "runner ended while the codex exec child is still running"
      : `runner ${runner}, child ${child}`;
  const noticeId = markTrackingLost(db, d, worker, turn, reason);
  return {
    ...base,
    evidence: "tracking_lost",
    activity: child === "alive" ? "running" : "unknown",
    owner: "exec",
    reason,
    noticeId,
  };
}

/** Re-checks inside the commit that the probed turn is still the current one: a stale probe changes nothing. */
function stillCurrent(db: Db, worker: SessionRow, turn: TurnRow): TurnRow | null {
  const w = getSession(db, worker.id);
  const t = getTurn(db, turn.id);
  if (!w || !t || w.generation !== t.generation) return null;
  const latest = latestTurn(db, t.delegation_id, w.generation);
  if (latest?.id !== t.id || t.state !== turn.state) return null;
  return t;
}

function markTrackingLost(
  db: Db,
  d: DelegationRow,
  worker: SessionRow,
  turn: TurnRow,
  reason: string,
): string | null {
  return tx(db, () => {
    const t = stillCurrent(db, worker, turn);
    if (!t || t.tracking === "lost") return null; // Deduplicated per evidence transition.
    updateTurn(db, t.id, { tracking: "lost", tracking_reason: reason, evidence_at: nowIso() });
    const delegation = getDelegation(db, d.request_id);
    const w = getSession(db, worker.id)!;
    const r = record(
      db,
      probeObs(w, t, "tracking_lost", { reason }),
      delegation,
      {
        kind: "tracking_lost",
        provider: w.provider as "claude" | "codex",
        excerpt: reason,
        label: "tracking lost",
      },
      noticeBlocker(db, delegation, t, w),
    );
    return r.noticeId;
  });
}

function restoreTracking(db: Db, worker: SessionRow, turn: TurnRow): void {
  tx(db, () => {
    const t = stillCurrent(db, worker, turn);
    // A live owner proves liveness, not that a previous owner's background work can still continue it.
    if (t?.tracking !== "lost" || t.tracking_reason === ORPHANED_BACKGROUND_REASON) return;
    updateTurn(db, t.id, { tracking: "ok", tracking_reason: null, evidence_at: nowIso() });
    record(db, probeObs(getSession(db, worker.id)!, t, "tracking_restored", {}), null, null);
  });
}

function interrupt(
  db: Db,
  d: DelegationRow,
  worker: SessionRow,
  turn: TurnRow,
  reason: string,
): string | null {
  return tx(db, () => {
    const t = stillCurrent(db, worker, turn);
    if (!t) return null;
    const now = nowIso();
    updateTurn(db, t.id, {
      state: "interrupted",
      ended_at: now,
      evidence_at: now,
      tracking: "ok",
      tracking_reason: null,
    });
    const delegation = getDelegation(db, d.request_id);
    const w = getSession(db, worker.id)!;
    const r = record(
      db,
      { ...probeObs(w, t, "turn_interrupted", { reason }), occurrenceKey: `probe:${t.id}:interrupted` },
      delegation,
      {
        kind: "turn_interrupted",
        provider: w.provider as "claude" | "codex",
        excerpt: reason,
        label: "turn interrupted",
      },
      noticeBlocker(db, delegation, t, w),
    );
    return r.noticeId;
  });
}

function probeObs(worker: SessionRow, turn: TurnRow, kind: string, detail: Record<string, unknown>) {
  return {
    id: newId(),
    occurrenceKey: null,
    sessionId: worker.id,
    delegationId: turn.delegation_id,
    turnRef: turn.id,
    generation: turn.generation,
    source: "probe" as const,
    kind,
    nativeEvent: null,
    nativeTurnId: null,
    capturedAt: nowIso(),
    detail,
  };
}
