import { BODY_LIMIT, type NoticeKind, type Provider } from "../protocol/types.ts";
import { type Db, SYSTEM_OBSERVER_ID } from "../store/db.ts";
import type { DelegationRow } from "../store/delegations.ts";
import { insertMessage } from "../store/messages.ts";
import {
  hasSuccessor,
  type InsertObservation,
  insertObservation,
  type TurnRow,
} from "../store/observations.ts";
import type { SessionRow } from "../store/sessions.ts";
import { oneLine, truncateUtf8 } from "../util/misc.ts";

export interface NoticeInput {
  kind: NoticeKind;
  provider: Provider;
  excerpt: string;
  /** Short label prefixed to the derived summary, e.g. "finished" or "permission: Bash". */
  label: string;
  /** Original byte length when the excerpt was already truncated at capture time. */
  capturedBytes?: number;
}

export interface Recorded {
  observationId: string;
  noticeId: string | null;
  suppressedBy: string | null;
}

/** Commits an observation and its optional notice together; callers hold the transaction. */
export function record(
  db: Db,
  obs: Omit<InsertObservation, "noticeId" | "suppressedBy">,
  delegation: DelegationRow | null,
  notice: NoticeInput | null,
  suppressedBy: string | null = null,
): Recorded {
  let noticeId: string | null = null;
  if (notice && delegation && !suppressedBy) {
    const cut = truncateUtf8(notice.excerpt, BODY_LIMIT - 256);
    const truncated = cut.truncated || notice.capturedBytes !== undefined;
    const originalBytes = notice.capturedBytes ?? cut.bytes;
    const body = truncated
      ? `${cut.text}\n\n[agentbus: excerpt truncated; original length ${originalBytes} bytes]`
      : cut.text;
    const summaryText = notice.excerpt.trim() ? `${notice.label}: ${notice.excerpt}` : notice.label;
    const msg = insertMessage(db, {
      fromId: SYSTEM_OBSERVER_ID,
      toId: delegation.parent_id,
      type: "notice",
      summary: oneLine(summaryText),
      body: body || `(${notice.label})`,
      correlationId: delegation.request_id,
      inReplyTo: null,
      idempotencyKey: `notice:${obs.id}`,
      intentHash: null,
      outcome: null,
      notice: {
        kind: notice.kind,
        observationId: obs.id,
        provider: notice.provider,
        ...(truncated ? { truncated: true, originalBytes } : {}),
      },
      turnRef: obs.turnRef,
    });
    noticeId = msg.id;
  }
  insertObservation(db, { ...obs, noticeId, suppressedBy });
  return { observationId: obs.id, noticeId, suppressedBy };
}

/** True when the worker sent a question or result attributed to exactly this bound turn. */
export function turnHasExplicitReport(db: Db, turnId: string): string | null {
  const row = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM messages WHERE turn_ref = ? AND type IN ('question', 'result') ORDER BY sequence LIMIT 1",
    )
    .get(turnId);
  return row?.id ?? null;
}

/**
 * Notices for a turn are posted only while its delegation is open, the turn belongs to the worker's
 * current binding generation and no later turn continued it. Returns a suppression reason otherwise.
 */
export function noticeBlocker(
  db: Db,
  delegation: DelegationRow | null,
  turn: TurnRow | null,
  session: SessionRow,
): string | null {
  if (!delegation) return "no_delegation";
  if (delegation.state !== "open") return "delegation_closed";
  if (!turn) return "no_bound_turn";
  if (turn.generation !== session.generation) return "stale_generation";
  if (hasSuccessor(db, turn.id)) return "continued_by_later_turn";
  return null;
}

export function lastNoticeBody(db: Db, turnId: string, kind: NoticeKind): string | null {
  const row = db
    .query<{ body: string; notice: string }, [string]>(
      "SELECT body, notice FROM messages WHERE turn_ref = ? AND type = 'notice' ORDER BY sequence DESC",
    )
    .all(turnId)
    .find((r) => JSON.parse(r.notice).kind === kind);
  return row?.body ?? null;
}
