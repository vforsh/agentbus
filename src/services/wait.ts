import { drainSpool, listSpool } from "../adapters/claude/spool.ts";
import type { Resolved } from "../config/config.ts";
import { ATTENTION_NOTICES, type MessageType, type Phase } from "../protocol/types.ts";
import { type Db, dataVersion, tx } from "../store/db.ts";
import { type DelegationRow, getDelegation, openDelegationsForParent } from "../store/delegations.ts";
import { budget, type MessageRow, markSeen, selectInbox } from "../store/messages.ts";
import {
  activeTurnForSession,
  endWaitArm,
  getWaitArm,
  insertWaitArm,
  supersedeWaitArms,
  type WaitArmRow,
} from "../store/observations.ts";
import { displayName, getSession, type SessionRow } from "../store/sessions.ts";
import { sleep } from "../util/misc.ts";
import { derivePhase, isSettled } from "./phase.ts";
import { probeDelegations } from "./probe.ts";

export interface WaitOptions {
  timeoutMs: number;
  probeMs: number | null;
  after: number | null;
  fromId: string | null;
  type: MessageType | null;
  correlation: string | null;
  limit: number;
  settled: boolean;
  /** Retire the caller's other running waits: one watcher per session. */
  replace: boolean;
}

export interface WaitOrigin {
  agentbusWaitOrigin: 1;
  armId: string;
  sessionId: string;
  delegationId: string | null;
  turnRef: string | null;
}

export interface BatchMember {
  requestId: string;
  worker: string;
  phase: Phase;
  outcome: string | null;
}

export interface WaitResult {
  rows: MessageRow[];
  hasMore: boolean;
  timedOut: boolean;
  reason: "messages" | "attention" | "settled" | "empty" | "timeout" | "superseded";
  origin: WaitOrigin;
  batch: BatchMember[] | null;
  /** Other running waits this one retired (--replace). */
  replaced: number;
}

const POLL_MS = 250;
const SPOOL_SCAN_MS = 1000;

function originOf(arm: WaitArmRow): WaitOrigin {
  return {
    agentbusWaitOrigin: 1,
    armId: arm.id,
    sessionId: arm.session_id,
    delegationId: arm.delegation_id,
    turnRef: arm.turn_ref,
  };
}

/** Records the wait's origin when armed: the caller's current bound turn, if it is a worker in one. */
function arm(
  db: Db,
  caller: SessionRow,
  correlation: string | null,
  replace: boolean,
): { arm: WaitArmRow; replaced: number } {
  return tx(db, () => {
    const me = getSession(db, caller.id)!;
    const turn = activeTurnForSession(db, me.id, me.generation);
    const row = insertWaitArm(db, {
      sessionId: me.id,
      delegationId: turn?.delegation_id ?? null,
      turnRef: turn?.id ?? null,
      correlation,
    });
    return { arm: row, replaced: replace ? supersedeWaitArms(db, me.id, row.id) : 0 };
  });
}

function batchTable(db: Db, ids: string[]): { members: BatchMember[]; rows: DelegationRow[] } {
  const rows = ids.map((id) => getDelegation(db, id)!).filter(Boolean);
  const members = rows.map((d) => {
    const p = derivePhase(db, d);
    const w = getSession(db, d.worker_id);
    return {
      requestId: d.request_id,
      worker: w ? displayName(w) : d.worker_id,
      phase: p.phase,
      outcome: p.outcome,
    };
  });
  return { members, rows };
}

const isAttention = (m: MessageRow): boolean =>
  m.type === "question" ||
  (m.type === "notice" && !!m.notice && ATTENTION_NOTICES.has(JSON.parse(m.notice).kind));

export async function runWait(
  db: Db,
  paths: Resolved,
  caller: SessionRow,
  opts: WaitOptions,
  hooks: { afterSeenCommit?: () => void; setArm?: (armId: string) => void } = {},
): Promise<WaitResult> {
  const deadline = Date.now() + opts.timeoutMs;
  drainSpool(db, paths);
  const { arm: armRow, replaced } = arm(db, caller, opts.correlation, opts.replace);
  hooks.setArm?.(armRow.id);
  const origin = originOf(armRow);

  let snapshot: string[] | null = null;
  if (opts.settled) {
    snapshot = openDelegationsForParent(db, caller.id)
      .map((d) => d.request_id)
      .filter((id) => !opts.correlation || id === opts.correlation);
    if (snapshot.length === 0) {
      endWaitArm(db, armRow.id, "empty");
      return { rows: [], hasMore: false, timedOut: false, reason: "empty", origin, batch: [], replaced };
    }
  }

  const finish = (r: Omit<WaitResult, "origin" | "replaced">): WaitResult => {
    endWaitArm(db, armRow.id, r.reason);
    return { ...r, origin, replaced };
  };

  const attempt = (): Omit<WaitResult, "origin" | "replaced"> | null => {
    const picked = tx(db, () => {
      // Checked in the claiming transaction: a superseded wait never marks mail seen.
      if (getWaitArm(db, armRow.id)?.end_reason === "superseded") {
        return { rows: [], hasMore: false, reason: "superseded" as const, batch: null };
      }
      const unseen = selectInbox(db, {
        recipientId: caller.id,
        includeAcknowledged: false,
        unseenOnly: true,
        after: opts.after,
        fromId: opts.fromId,
        type: opts.type,
        correlationIds: snapshot ?? (opts.correlation ? [opts.correlation] : null),
        limit: snapshot ? 1000 : opts.limit,
      });
      if (!snapshot) {
        if (unseen.rows.length === 0) return null;
        markSeen(
          db,
          unseen.rows.map((r) => r.id),
        );
        return { rows: unseen.rows, hasMore: unseen.hasMore, reason: "messages" as const, batch: null };
      }
      const attention = unseen.rows.filter(isAttention);
      const table = batchTable(db, snapshot);
      let reason: "attention" | "settled" | null = null;
      if (attention.length > 0) reason = "attention";
      else if (table.members.every((m) => isSettled(m.phase))) reason = "settled";
      if (!reason) return null;
      const ordered = [...attention, ...unseen.rows.filter((r) => !isAttention(r))];
      const b = budget(ordered, opts.limit);
      markSeen(
        db,
        b.rows.map((r) => r.id),
      );
      return { rows: b.rows, hasMore: b.hasMore || unseen.hasMore, reason, batch: table.members };
    });
    if (!picked) return null;
    hooks.afterSeenCommit?.();
    return { ...picked, timedOut: false };
  };

  // Sample data_version before each query so a commit landing between query and sample is never missed.
  let lastVersion = dataVersion(db);
  const first = attempt();
  if (first) return finish(first);
  let nextSpool = Date.now() + SPOOL_SCAN_MS;
  let nextProbe = opts.probeMs ? Date.now() : Number.POSITIVE_INFINITY;

  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    let local = false;
    const now = Date.now();
    if (now >= nextSpool) {
      nextSpool = now + SPOOL_SCAN_MS;
      if (listSpool(paths).length > 0) {
        const r = drainSpool(db, paths);
        local ||= r.ingested > 0;
      }
    }
    if (now >= nextProbe && opts.probeMs) {
      nextProbe = now + opts.probeMs;
      const targets = snapshot
        ? snapshot.map((id) => getDelegation(db, id)!).filter(Boolean)
        : openDelegationsForParent(db, caller.id);
      probeDelegations(db, paths, targets, { deadline });
      local = true; // Probes may change phases without new messages; settled mode must re-evaluate.
    }
    const version = dataVersion(db);
    if (version === lastVersion && !local) continue;
    lastVersion = version;
    const got = attempt();
    if (got) return finish(got);
  }
  const table = snapshot ? batchTable(db, snapshot).members : null;
  return finish({ rows: [], hasMore: false, timedOut: true, reason: "timeout", batch: table });
}
