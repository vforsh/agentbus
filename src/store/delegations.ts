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

/** First terminal transition wins: the update only applies while the delegation is still open. */
export function closeDelegation(
  db: Db,
  requestId: string,
  state: "done" | "closed",
  outcome: Outcome | null,
  resultId: string | null,
): boolean {
  const res = db
    .query(
      "UPDATE delegations SET state = ?, outcome = ?, result_id = ?, closed_at = ? WHERE request_id = ? AND state = 'open'",
    )
    .run(state, outcome, resultId, nowIso(), requestId);
  return res.changes > 0;
}

export interface ParentFilter {
  parentId: string;
  includeAll: boolean;
  recentSinceIso: string;
}

export function delegationsForParent(db: Db, f: ParentFilter): DelegationRow[] {
  if (f.includeAll) {
    return db
      .query<DelegationRow, [string]>("SELECT * FROM delegations WHERE parent_id = ? ORDER BY opened_at")
      .all(f.parentId);
  }
  return db
    .query<DelegationRow, [string, string]>(
      "SELECT * FROM delegations WHERE parent_id = ? AND (state = 'open' OR closed_at >= ?) ORDER BY opened_at",
    )
    .all(f.parentId, f.recentSinceIso);
}

export function openDelegationsForParent(db: Db, parentId: string): DelegationRow[] {
  return db
    .query<DelegationRow, [string]>(
      "SELECT * FROM delegations WHERE parent_id = ? AND state = 'open' ORDER BY opened_at",
    )
    .all(parentId);
}
