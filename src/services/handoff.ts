// Desktop handoff guard: a background owner may be released only when the latest Stop of the current
// binding generation reported known, empty background-task and scheduled-wakeup lists. Launchers combine
// this with a fresh positive idle probe immediately before stopping the owner.

import type { Db } from "../store/db.ts";
import type { DelegationRow } from "../store/delegations.ts";
import { latestTurn } from "../store/observations.ts";
import { getSession } from "../store/sessions.ts";

export interface Handoff {
  ready: boolean;
  reason: string;
}

const notReady = (reason: string): Handoff => ({ ready: false, reason });

export function handoffReadiness(db: Db, d: DelegationRow): Handoff {
  const worker = getSession(db, d.worker_id);
  if (!worker?.external_id) return notReady("worker not bound yet");
  const turn = latestTurn(db, d.request_id);
  if (!turn) return notReady("no bound turn observed");
  if (worker.generation !== turn.generation) return notReady("binding superseded by unrelated input");
  if (turn.tracking === "lost") return notReady(turn.tracking_reason ?? "tracking lost");
  if (turn.state === "active" || turn.state === "prepared") return notReady("bound turn still active");
  if (turn.state !== "finished")
    return notReady(`latest bound turn ${turn.state}; check the worker before handing off`);
  if (turn.bg_running === null) return notReady("background task list unknown");
  if (turn.bg_running > 0) return notReady(`${turn.bg_running} background task(s) still running`);
  if (turn.crons === null) return notReady("scheduled wakeups unknown");
  if (turn.crons > 0) return notReady(`${turn.crons} scheduled wakeup(s) pending`);
  return { ready: true, reason: "latest Stop reported no background tasks or scheduled wakeups" };
}
