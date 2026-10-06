// Return-path readiness: whether a parent will currently be woken when its delegation produces mail.
// Derived from current evidence, never from a flag: a live wait arm whose process and owner still exist, or
// for app-only heartbeats (which the CLI can neither query nor create) a fresh check-in the parent recorded.
// Unknown stays unknown: a failed `ps` is unverified, not dead, and never armed.

import { type Liveness, livenessAll, type ProcessIdentity } from "../adapters/process.ts";
import { MAX_WAIT_MS, type ReturnPath, type ReturnPathStatus } from "../protocol/types.ts";
import type { Db } from "../store/db.ts";
import type { DelegationRow } from "../store/delegations.ts";
import { openWaitArms, recentWaitArms, type WaitArmRow } from "../store/observations.ts";
import { getSession, type SessionRow } from "../store/sessions.ts";
import { formatAge, formatMs, parseDuration } from "../util/misc.ts";
import { proposeReturnPath } from "./mailbox.ts";

export type Readiness =
  | "armed"
  | "unverified"
  | "owner_lost"
  | "not_armed"
  | "reported"
  | "stale"
  | "not_reported"
  | "unsupported";

export interface WatcherEvidence {
  armId: string;
  scope: WaitArmRow["scope"];
  correlation: string | null;
  pid: number | null;
  createdAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  /** live | owner_lost | unverified | dead | expired | ended */
  state: ArmState;
}

export interface ReportedBinding {
  strategy: string;
  status: string;
  handle: string | null;
  checkedAt: string | null;
  interval: string | null;
  staleAfterMs: number;
  fresh: boolean;
}

export interface ReturnReadiness {
  strategy: ReturnPath | "adapter";
  /** Coarse, backward-compatible status: ready only on current evidence. */
  status: ReturnPathStatus;
  readiness: Readiness;
  reason: string;
  evidenceAt: string | null;
  source: "wait_arm" | "parent_report" | "none";
  watcher: WatcherEvidence | null;
  reported: ReportedBinding | null;
}

type ArmState = "live" | "owner_lost" | "unverified" | "dead" | "expired" | "ended";

/** An unended arm past its own timeout by more than this cannot belong to a running wait. */
const EXPIRY_GRACE_MS = 60_000;
/** Default heartbeat freshness when the binding names no interval; otherwise three intervals. */
export const DEFAULT_REPORT_FRESHNESS_MS = 15 * 60_000;

const parseJson = <T>(text: string | null): T | null => (text ? (JSON.parse(text) as T) : null);

function armState(arm: WaitArmRow, now: number, probe: (ids: ProcessIdentity[]) => Liveness[]): ArmState {
  if (arm.ended_at) return "ended";
  const self = parseJson<ProcessIdentity>(arm.process);
  const expiry = arm.expires_at ? Date.parse(arm.expires_at) : Date.parse(arm.created_at) + MAX_WAIT_MS;
  if (expiry + EXPIRY_GRACE_MS < now) return "expired";
  // Recorded before migration 6, or the wait could not identify itself: never proof of an armed path.
  if (!self) return "unverified";
  const owner = parseJson<ProcessIdentity[]>(arm.owner) ?? [];
  const [me, ...ancestors] = probe([self, ...owner]);
  if (me === "dead") return "dead";
  if (me === "unknown") return "unverified";
  if (ancestors.includes("dead")) return "owner_lost";
  if (ancestors.includes("unknown") || owner.length === 0) return "unverified";
  return "live";
}

/**
 * Whether an arm delivers this delegation's mail; with no delegation, whether it covers future ones too.
 * `asWorker`: the session waits for its own request's answers, which a --settled snapshot of its children
 * never delivers.
 */
function covers(arm: WaitArmRow, d: DelegationRow | null, asWorker = false): boolean {
  if (!d) return arm.scope === "all" || (arm.scope === null && !arm.correlation);
  if (asWorker && arm.scope === "settled") return false;
  switch (arm.scope) {
    case "all":
      return true;
    case "correlation":
      return arm.correlation === d.request_id;
    case "settled":
      return (!arm.correlation || arm.correlation === d.request_id) && d.opened_at <= arm.created_at;
    case "filtered":
      return false;
    default:
      return !arm.correlation || arm.correlation === d.request_id;
  }
}

function watcher(arm: WaitArmRow, state: ArmState): WatcherEvidence {
  return {
    armId: arm.id,
    scope: arm.scope,
    correlation: arm.correlation,
    pid: parseJson<ProcessIdentity>(arm.process)?.pid ?? null,
    createdAt: arm.created_at,
    expiresAt: arm.expires_at,
    endedAt: arm.ended_at,
    endReason: arm.end_reason,
    state,
  };
}

const ENDED_BECAUSE: Record<string, string> = {
  timeout: "timed out",
  interrupted: "was interrupted",
  superseded: "was superseded by a newer wait",
  messages: "returned with mail",
  attention: "returned with attention items",
  settled: "returned with its batch settled",
  empty: "returned with an empty batch",
};

function reportedBinding(parent: SessionRow, now: number): ReportedBinding | null {
  const b = parseJson<Record<string, unknown>>(parent.return_binding);
  if (!b) return null;
  const interval = typeof b.interval === "string" ? b.interval : null;
  let staleAfterMs = DEFAULT_REPORT_FRESHNESS_MS;
  if (interval) {
    try {
      staleAfterMs = 3 * parseDuration(interval, "interval");
    } catch {}
  }
  const checkedAt = typeof b.checkedAt === "string" ? b.checkedAt : null;
  return {
    strategy: String(b.strategy),
    status: String(b.status),
    handle: typeof b.handle === "string" ? b.handle : null,
    checkedAt,
    interval,
    staleAfterMs,
    fresh: !!checkedAt && now - Date.parse(checkedAt) <= staleAfterMs,
  };
}

/**
 * Resolves readiness per delegation; process checks are cached per parent, so a listing costs one `ps` call
 * per parent with an unended wait.
 */
export function returnPathResolver(db: Db, now = Date.now()) {
  const armCache = new Map<string, { arm: WaitArmRow; state: ArmState }[]>();
  const evaluated = (parentId: string) => {
    let hit = armCache.get(parentId);
    if (!hit) {
      const arms = openWaitArms(db, parentId);
      // One ps call for every identity of every unended arm of this parent.
      const ids = arms.flatMap((a) => [
        parseJson<ProcessIdentity>(a.process),
        ...(parseJson<ProcessIdentity[]>(a.owner) ?? []),
      ]);
      const known = ids.filter((x): x is ProcessIdentity => !!x);
      const results = new Map<string, Liveness>();
      if (known.length > 0) {
        const lv = livenessAll(known);
        for (const [i, id] of known.entries()) results.set(`${id.pid}:${id.start}`, lv[i]!);
      }
      const probe = (list: ProcessIdentity[]) =>
        list.map((id) => results.get(`${id.pid}:${id.start}`) ?? "unknown");
      hit = arms.map((arm) => ({ arm, state: armState(arm, now, probe) }));
      armCache.set(parentId, hit);
    }
    return hit;
  };

  /** `waitOnly` judges just the session's own waits (a worker waiting for its answer), never a heartbeat. */
  return (parent: SessionRow, d: DelegationRow | null, waitOnly = false): ReturnReadiness => {
    const reported = waitOnly ? null : reportedBinding(parent, now);
    const proposed = proposeReturnPath(parent).returnPath;
    const strategy = waitOnly
      ? "background_wait"
      : ((reported?.strategy as ReturnReadiness["strategy"] | undefined) ?? d?.return_path ?? proposed);
    const base = { strategy, reported };
    const covering = evaluated(parent.id).filter((x) => covers(x.arm, d, waitOnly));
    const scopeText = (arm: WaitArmRow) =>
      arm.scope === "all"
        ? "covers every delegation of this parent, including later ones"
        : `scope ${arm.scope}`;

    const pick = (state: ArmState) => covering.find((x) => x.state === state);
    const live = pick("live");
    if (live) {
      return {
        ...base,
        status: "ready",
        readiness: "armed",
        reason: `watcher armed ${formatAge(live.arm.created_at, now)} ago (pid ${watcher(live.arm, "live").pid}); ${scopeText(live.arm)}`,
        evidenceAt: live.arm.created_at,
        source: "wait_arm",
        watcher: watcher(live.arm, "live"),
      };
    }
    const unverified = pick("unverified");
    if (unverified) {
      return {
        ...base,
        status: "unknown",
        readiness: "unverified",
        reason: unverified.arm.process
          ? "an unended watcher exists, but its process could not be checked"
          : unverified.arm.scope === null
            ? "an unended watcher from an older agentbus has no recorded process identity"
            : "an unended watcher could not record its process identity when armed",
        evidenceAt: unverified.arm.created_at,
        source: "wait_arm",
        watcher: watcher(unverified.arm, "unverified"),
      };
    }

    const orphan = pick("owner_lost");
    if (orphan) {
      return {
        ...base,
        status: "setup_required",
        readiness: "owner_lost",
        reason:
          "the watcher process is still running, but the process that armed it has exited (crash, kill or a resumed/respawned owner); its exit will not re-invoke the parent",
        evidenceAt: orphan.arm.created_at,
        source: "wait_arm",
        watcher: watcher(orphan.arm, "owner_lost"),
      };
    }
    if (strategy === "heartbeat" && reported) {
      if (reported.status !== "ready") {
        return {
          ...base,
          status: reported.status === "unsupported" ? "unsupported" : "setup_required",
          readiness: reported.status === "unsupported" ? "unsupported" : "not_reported",
          reason: `parent reported heartbeat ${reported.status}`,
          evidenceAt: reported.checkedAt,
          source: "parent_report",
          watcher: null,
        };
      }
      const age = reported.checkedAt ? formatAge(reported.checkedAt, now) : "?";
      return reported.fresh
        ? {
            ...base,
            status: "ready",
            readiness: "reported",
            reason: `heartbeat checked in ${age} ago (fresh for ${formatMs(reported.staleAfterMs)}); app automations cannot be verified by agentbus`,
            evidenceAt: reported.checkedAt,
            source: "parent_report",
            watcher: null,
          }
        : {
            ...base,
            status: "unknown",
            readiness: "stale",
            reason: `last heartbeat check-in was ${age} ago, older than its freshness window; the heartbeat may be gone`,
            evidenceAt: reported.checkedAt,
            source: "parent_report",
            watcher: null,
          };
    }
    if (strategy === "manual" || strategy === "adapter") {
      return {
        ...base,
        status: "unsupported",
        readiness: "unsupported",
        reason: "no verified wake facility for this parent; poll with `agentbus read`",
        evidenceAt: null,
        source: "none",
        watcher: null,
      };
    }
    if (strategy === "heartbeat") {
      return {
        ...base,
        status: "setup_required",
        readiness: "not_reported",
        reason: "no heartbeat check-in recorded and no watcher running",
        evidenceAt: null,
        source: "none",
        watcher: null,
      };
    }
    // Background wait with nothing running: explain the latest relevant watcher's end.
    const dead = covering.find((x) => x.state === "dead" || x.state === "expired");
    const last =
      dead ??
      recentWaitArms(db, parent.id, 20)
        .map((arm) => ({ arm, state: "ended" as ArmState }))
        .find((x) => covers(x.arm, d, waitOnly));
    if (!last) {
      return {
        ...base,
        status: "setup_required",
        readiness: "not_armed",
        reason: "no watcher has been armed",
        evidenceAt: null,
        source: "none",
        watcher: null,
      };
    }
    const why =
      last.state === "dead"
        ? "ended without recording an exit (killed or crashed)"
        : last.state === "expired"
          ? "is past its timeout without recording an exit"
          : (ENDED_BECAUSE[last.arm.end_reason ?? ""] ?? `ended (${last.arm.end_reason})`);
    const at = last.arm.ended_at ?? last.arm.expires_at ?? last.arm.created_at;
    return {
      ...base,
      status: "setup_required",
      readiness: "not_armed",
      reason: `no watcher running; the last one ${why} ${formatAge(at, now)} ago`,
      evidenceAt: at,
      source: "wait_arm",
      watcher: watcher(last.arm, last.state),
    };
  };
}

/** One-off readiness of a parent for a delegation (or for delegations it opens next, with null). */
export function returnReadiness(db: Db, parentId: string, d: DelegationRow | null): ReturnReadiness | null {
  const parent = getSession(db, parentId);
  return parent ? returnPathResolver(db)(parent, d) : null;
}
