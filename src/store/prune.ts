import { MAX_WAIT_MS } from "../protocol/types.ts";
import { parseDuration } from "../util/misc.ts";
import { type Db, SYSTEM_OBSERVER_ID, tx } from "./db.ts";

export interface PrunedWorker {
  workerId: string;
  name: string | null;
  requestIds: string[];
}

export interface PruneCounts {
  workers: number;
  delegations: number;
  messages: number;
  receipts: number;
  turnBindings: number;
  observations: number;
  waitArms: number;
}

export interface PruneResult {
  cutoff: string;
  dryRun: boolean;
  pruned: PrunedWorker[];
  counts: PruneCounts;
}

/**
 * A worker session is the unit of pruning: it goes with every delegation it worked on, all mail to or from it,
 * and its observation history. It qualifies only when:
 * - `delegate` created it (a contract was issued); sessions registered by hand, parents included, are never
 *   pruned, because they must keep resolving even when someone once sent them a request;
 * - every delegation it worked on is terminal and ended before the cutoff;
 * - every delegation it leads is pruned with it (nested leads go after their children);
 * - it has been quiet for the whole window: no mail to or from it, no observation and no wait since the cutoff,
 *   and no wait that may still be running (an unended arm younger than the longest possible wait);
 * - every receipt of the doomed mail is acknowledged unless the worker itself is the recipient: mail nobody
 *   surviving will read goes with its recipient, but a parent's unhandled mail keeps the worker.
 */
const ELIGIBLE_WORKERS = `
  SELECT s.id FROM sessions s
  WHERE s.id <> $system
    AND EXISTS (SELECT 1 FROM delegations d WHERE d.worker_id = s.id AND d.contract_version IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM delegations d WHERE d.worker_id = s.id AND (d.state = 'open' OR d.closed_at >= $cutoff))
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.to_id = s.id AND m.created_at >= $cutoff)
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.from_id = s.id AND m.created_at >= $cutoff)
    AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.session_id = s.id AND o.captured_at >= $cutoff)
    AND NOT EXISTS (
      SELECT 1 FROM wait_arms w WHERE w.session_id = s.id
        AND (w.created_at >= $cutoff OR w.ended_at >= $cutoff OR (w.ended_at IS NULL AND w.created_at >= $liveSince)))
    AND NOT EXISTS (
      SELECT 1 FROM receipts r JOIN messages m ON m.id = r.message_id
      WHERE r.acknowledged_at IS NULL AND r.recipient_id <> s.id
        AND (m.from_id = s.id OR m.to_id = s.id
          OR m.correlation_id IN (SELECT request_id FROM delegations WHERE worker_id = s.id)))`;

/** Doomed rows per table, in foreign-key deletion order: observations and waits, turns, delegations, mail, sessions. */
const DOOMED: ReadonlyArray<{ key: keyof PruneCounts; table: string; where: string }> = [
  {
    key: "observations",
    table: "observations",
    where: `session_id IN prune_workers OR delegation_id IN prune_delegations OR turn_ref IN prune_turns
      OR notice_id IN prune_messages`,
  },
  {
    key: "waitArms",
    table: "wait_arms",
    where: "session_id IN prune_workers OR delegation_id IN prune_delegations OR turn_ref IN prune_turns",
  },
  { key: "turnBindings", table: "turn_bindings", where: "id IN prune_turns" },
  { key: "delegations", table: "delegations", where: "request_id IN prune_delegations" },
  { key: "receipts", table: "receipts", where: "message_id IN prune_messages" },
  { key: "messages", table: "messages", where: "id IN prune_messages" },
  { key: "workers", table: "sessions", where: "id IN prune_workers" },
];

function collect(db: Db, cutoff: string, liveSince: string): void {
  db.run("CREATE TEMP TABLE prune_workers (id TEXT PRIMARY KEY)");
  db.run("CREATE TEMP TABLE prune_delegations (id TEXT PRIMARY KEY)");
  db.run("CREATE TEMP TABLE prune_messages (id TEXT PRIMARY KEY)");
  db.run("CREATE TEMP TABLE prune_turns (id TEXT PRIMARY KEY)");
  // A worker that leads its own children qualifies once they are gone, so repeat until nothing changes.
  const step = db.query(
    `INSERT INTO prune_workers ${ELIGIBLE_WORKERS}
       AND s.id NOT IN prune_workers
       AND NOT EXISTS (
         SELECT 1 FROM delegations d WHERE d.parent_id = s.id AND d.worker_id NOT IN prune_workers)`,
  );
  let added: number;
  do added = step.run({ system: SYSTEM_OBSERVER_ID, cutoff, liveSince }).changes;
  while (added > 0);
  db.run("INSERT INTO prune_delegations SELECT request_id FROM delegations WHERE worker_id IN prune_workers");
  db.run(
    `INSERT OR IGNORE INTO prune_messages SELECT id FROM messages
     WHERE correlation_id IN prune_delegations OR from_id IN prune_workers OR to_id IN prune_workers`,
  );
  db.run(
    `INSERT INTO prune_turns SELECT id FROM turn_bindings
     WHERE session_id IN prune_workers OR delegation_id IN prune_delegations`,
  );
}

function drop(db: Db): void {
  for (const t of ["prune_workers", "prune_delegations", "prune_messages", "prune_turns"])
    db.run(`DROP TABLE IF EXISTS temp.${t}`);
}

/** Prune bounds for a retention window; `liveSince` bounds how old an unended wait arm may be and still run. */
export function pruneWindow(olderThan: string, now = Date.now()): { cutoff: string; liveSince: string } {
  return {
    cutoff: new Date(now - parseDuration(olderThan, "--older-than")).toISOString(),
    liveSince: new Date(now - MAX_WAIT_MS).toISOString(),
  };
}

/**
 * Removes finished workers and their history older than `cutoff`. `liveSince` bounds how old an unended wait
 * arm may be and still belong to a running wait. A dry run reports the same set from a read transaction, so it
 * never holds the write lock.
 */
export function prune(db: Db, opts: { cutoff: string; liveSince: string; dryRun: boolean }): PruneResult {
  const { cutoff, liveSince, dryRun } = opts;
  const run = () => {
    try {
      collect(db, cutoff, liveSince);
      const pruned = db
        .query<{ workerId: string; name: string | null; requestIds: string }, []>(
          `SELECT s.id AS workerId, s.name AS name,
             (SELECT json_group_array(request_id) FROM
               (SELECT request_id FROM delegations WHERE worker_id = s.id ORDER BY opened_at)) AS requestIds
           FROM sessions s WHERE s.id IN prune_workers ORDER BY s.created_at`,
        )
        .all()
        .map((w) => ({ ...w, requestIds: JSON.parse(w.requestIds) as string[] }));
      const counts = {} as PruneCounts;
      for (const { key, table, where } of DOOMED) {
        counts[key] = dryRun
          ? db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get()!.n
          : db.query(`DELETE FROM ${table} WHERE ${where}`).run().changes;
      }
      return { cutoff, dryRun, pruned, counts };
    } finally {
      drop(db);
    }
  };
  return dryRun ? db.transaction(run).deferred() : tx(db, run);
}
