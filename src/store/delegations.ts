import type { Outcome, ReturnPath, ReturnPathStatus } from "../protocol/types.ts";
import { nowIso } from "../util/misc.ts";
import type { Db } from "./db.ts";

export interface DelegationRow {
  request_id: string;
  parent_id: string;
  worker_id: string;
  state: "open" | "done" | "closed";
  outcome: Outcome | null;
  result_id: string | null;
  contract_version: number | null;
  contract: string | null;
  return_path: ReturnPath;
  return_path_status: ReturnPathStatus;
  return_path_reason: string | null;
  opened_at: string;
  closed_at: string | null;
}

export function getDelegation(db: Db, requestId: string): DelegationRow | null {
  return db.query<DelegationRow, [string]>("SELECT * FROM delegations WHERE request_id = ?").get(requestId);
}

export function openDelegationForWorker(db: Db, workerId: string): DelegationRow | null {
  return db
    .query<DelegationRow, [string]>("SELECT * FROM delegations WHERE worker_id = ? AND state = 'open'")
    .get(workerId);
}

export interface InsertDelegation {
  requestId: string;
  parentId: string;
  workerId: string;
  contractVersion: number | null;
  contract: string | null;
  returnPath: ReturnPath;
  returnPathStatus: ReturnPathStatus;
  returnPathReason: string | null;
}

export function insertDelegation(db: Db, d: InsertDelegation): DelegationRow {
  db.query(
    `INSERT INTO delegations (request_id, parent_id, worker_id, state, contract_version, contract, return_path,
       return_path_status, return_path_reason, opened_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.requestId,
    d.parentId,
    d.workerId,
    d.contractVersion,
    d.contract,
    d.returnPath,
    d.returnPathStatus,
    d.returnPathReason,
    nowIso(),
  );
  return getDelegation(db, d.requestId)!;
}

/**
 * First terminal transition wins: the update only applies while the delegation is still open. The same
 * transition settles mail nobody needs to handle any more (receipts acknowledged with a `settled_reason`):
 * a result settles the worker's side (request, follow-ups, answers), a parent's close settles the whole
 * correlation. A result's own receipt is the parent's to acknowledge and is never settled.
 */
export function closeDelegation(
  db: Db,
  requestId: string,
  state: "done" | "closed",
  outcome: Outcome | null,
  resultId: string | null,
): boolean {
  const now = nowIso();
  const res = db
    .query(
      "UPDATE delegations SET state = ?, outcome = ?, result_id = ?, closed_at = ? WHERE request_id = ? AND state = 'open'",
    )
    .run(state, outcome, resultId, now, requestId);
  if (res.changes === 0) return false;
  db.query(
    `UPDATE receipts SET acknowledged_at = $now, seen_at = coalesce(seen_at, $now), settled_reason = $reason
     WHERE acknowledged_at IS NULL
       AND message_id IN (SELECT id FROM messages WHERE correlation_id = $request)
       AND ($state = 'closed' OR recipient_id = (SELECT worker_id FROM delegations WHERE request_id = $request))`,
  ).run({ now, reason: `delegation_${state}`, request: requestId, state });
  return true;
}

export interface ParentFilter {
  /** null lists every parent's delegations. */
  parentId: string | null;
  includeAll: boolean;
  recentSinceIso: string;
}

export function delegationsForParent(db: Db, f: ParentFilter): DelegationRow[] {
  return db
    .query<DelegationRow, [Record<string, string | number | null>]>(
      `SELECT * FROM delegations
       WHERE ($parent IS NULL OR parent_id = $parent) AND ($all OR state = 'open' OR closed_at >= $since)
       ORDER BY opened_at`,
    )
    .all({ parent: f.parentId, all: f.includeAll ? 1 : 0, since: f.recentSinceIso });
}

export function openDelegationsForParent(db: Db, parentId: string): DelegationRow[] {
  return db
    .query<DelegationRow, [string]>(
      "SELECT * FROM delegations WHERE parent_id = ? AND state = 'open' ORDER BY opened_at",
    )
    .all(parentId);
}

/** The most recent delegation between this parent and worker, open or not. */
export function latestDelegationBetween(db: Db, parentId: string, workerId: string): DelegationRow | null {
  return db
    .query<DelegationRow, [string, string]>(
      "SELECT * FROM delegations WHERE parent_id = ? AND worker_id = ? ORDER BY opened_at DESC, rowid DESC LIMIT 1",
    )
    .get(parentId, workerId);
}
