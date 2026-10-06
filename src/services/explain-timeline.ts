// Chronological delegation evidence, formatted without message bodies or raw tool input.

import type { NoticeMeta } from "../protocol/types.ts";
import type { Db } from "../store/db.ts";
import { type DelegationRow, delegationsForParent } from "../store/delegations.ts";
import type { MessageRow } from "../store/messages.ts";
import {
  type ObservationRow,
  observationsForDelegation,
  type WaitArmRow,
  waitArmsBetween,
} from "../store/observations.ts";
import type { SessionRow } from "../store/sessions.ts";
import { formatAge, nowIso } from "../util/misc.ts";

export type Actor = "parent" | "worker" | "observer" | "agentbus";

export interface ExplainEvent {
  at: string;
  kind: string;
  source: "mailbox" | "claude-hook" | "codex-runner" | "probe" | "wait" | "agentbus";
  actor: Actor;
  text: string;
  refs: {
    messageId?: string;
    sequence?: number;
    observationId?: string;
    turnRef?: string | null;
    generation?: number | null;
    armId?: string;
  };
  /** Delivery state of a message: new, seen, acked or settled. */
  receipt?: "new" | "seen" | "acked" | "settled";
}

function receiptOf(m: MessageRow): ExplainEvent["receipt"] {
  if (m.settled_reason) return "settled";
  if (m.acknowledged_at) return "acked";
  return m.seen_at ? "seen" : "new";
}

function messageText(m: MessageRow, d: DelegationRow, questions: ReadonlySet<string>): string {
  let label: string = m.type;
  if (m.type === "result") label = `result/${m.outcome}`;
  if (m.type === "notice" && m.notice) label = `notice/${(JSON.parse(m.notice) as NoticeMeta).kind}`;
  if (m.type === "message" && m.from_id === d.parent_id) {
    if (!m.in_reply_to) label = "follow-up";
    else if (questions.has(m.in_reply_to)) label = "answer";
    else label = "reply";
  }
  const bytes = Buffer.byteLength(m.body, "utf8");
  return `${label}: ${m.summary ?? `(no summary, ${bytes} bytes)`}`;
}

function observationText(o: ObservationRow): string {
  const detail = JSON.parse(o.detail) as Record<string, unknown>;
  const val = (k: string) =>
    typeof detail[k] === "string" || typeof detail[k] === "number" ? String(detail[k]) : null;
  switch (o.kind) {
    case "turn_started":
      return `turn started (${val("origin") ?? o.native_event ?? "runner"})`;
    case "turn_finished": {
      if (detail.attributed === false) return "turn finished (not attributed to this delegation)";
      const bg = detail.backgroundRunning;
      let extra = "";
      if (typeof bg === "number" && bg > 0) extra = `, ${bg} background task(s) running`;
      else if (bg === null) extra = ", background task list unknown";
      return `turn finished${extra}${o.suppressed_by ? " (no notice: explicit report)" : ""}`;
    }
    case "turn_failed":
      return `turn failed${val("errorType") ? ` (${val("errorType")})` : ""}`;
    case "turn_interrupted":
      return `turn interrupted${val("reason") ? `: ${val("reason")}` : ""}`;
    case "permission_request":
      return `permission requested${val("tool") ? `: ${val("tool")}` : ""}`;
    case "tracking_lost":
      return `tracking lost: ${val("reason") ?? "unknown reason"}`;
    case "tracking_restored":
      return "tracking restored by a live owner";
    case "owner_started":
      return `owner process started (${val("source") ?? "unknown"})`;
    case "owner_released":
      return `owner process released${val("reason") ? ` (${val("reason")})` : ""}`;
    case "launch_failed":
      return `launch failed: ${val("reason") ?? ""}`;
    case "prompt_unbound":
      return "prompt without delegation provenance (not attributed)";
    case "prompt_stale":
      return "delayed prompt recorded for history (not attributed)";
    case "run_started":
      return detail.replay ? "runner start replayed" : "runner started a run";
    case "child_started":
      return "codex exec child started";
    case "thread_started":
      return `thread started${val("threadId") ? ` ${val("threadId")}` : ""}`;
    default:
      return o.kind;
  }
}

function armText(a: WaitArmRow, who: "parent" | "worker"): string {
  let scope: string = a.scope ?? "unknown scope";
  if (a.scope === "all") scope = "all delegations";
  return `${who} wait armed (${scope})`;
}

export function explanationTimeline(
  db: Db,
  d: DelegationRow,
  msgs: MessageRow[],
  worker: SessionRow | null,
  now: number,
): ExplainEvent[] {
  const end = d.closed_at ?? nowIso();
  // The request and the delegation commit in one transaction; the request row is stamped first.
  const request = msgs.find((m) => m.id === d.request_id);
  const openedAt = request && request.created_at < d.opened_at ? request.created_at : d.opened_at;
  const events: ExplainEvent[] = [
    {
      at: openedAt,
      kind: "delegation_opened",
      source: "mailbox",
      actor: "parent",
      text: "delegation opened",
      refs: {},
    },
  ];
  const roleOf = (id: string): Actor => {
    if (id === d.parent_id) return "parent";
    if (id === d.worker_id) return "worker";
    if (id.startsWith("00000000-")) return "observer";
    return "agentbus";
  };
  const questions = new Set(msgs.filter((m) => m.type === "question").map((m) => m.id));
  for (const m of msgs) {
    events.push({
      at: m.created_at,
      kind: m.type,
      source: "mailbox",
      actor: roleOf(m.from_id),
      text: messageText(m, d, questions),
      refs: { messageId: m.id, sequence: m.sequence, turnRef: m.turn_ref },
      receipt: receiptOf(m),
    });
  }
  if (worker?.bound_at && worker.bound_at >= d.opened_at) {
    events.push({
      at: worker.bound_at,
      kind: "worker_bound",
      source: "agentbus",
      actor: "agentbus",
      text: `worker bound to ${worker.provider}:${worker.external_id}`,
      refs: {},
    });
  }
  // Evidence keeps arriving after a result (the Stop that follows it), so worker observations run to now
  // unless a later delegation of the same worker took over.
  const next = worker
    ? delegationsForParent(db, { parentId: d.parent_id, includeAll: true, recentSinceIso: "" }).find(
        (x) => x.worker_id === d.worker_id && x.opened_at > d.opened_at,
      )
    : undefined;
  const obsEnd = next?.opened_at ?? new Date(now + 1000).toISOString();
  for (const o of observationsForDelegation(db, d.request_id, d.worker_id, d.opened_at, obsEnd)) {
    events.push({
      at: o.captured_at,
      kind: o.kind,
      source: o.source,
      actor: "observer",
      text: `${observationText(o)}${o.generation !== null ? ` [gen ${o.generation}]` : ""}`,
      refs: {
        observationId: o.id,
        turnRef: o.turn_ref,
        generation: o.generation,
        ...(o.notice_id ? { messageId: o.notice_id } : {}),
      },
    });
  }
  const arms = (session: string, who: "parent" | "worker") =>
    waitArmsBetween(db, session, d.opened_at, end).filter((a) =>
      who === "worker"
        ? a.correlation === d.request_id || a.delegation_id === d.request_id || a.scope === "all"
        : true,
    );
  for (const [session, who] of [
    [d.parent_id, "parent"],
    [d.worker_id, "worker"],
  ] as const) {
    for (const a of arms(session, who)) {
      if (who === "parent" && a.correlation && a.correlation !== d.request_id) continue;
      if (a.created_at < d.opened_at && (!a.ended_at || a.ended_at > d.opened_at))
        events.push({
          at: d.opened_at,
          kind: "wait_running",
          source: "wait",
          actor: who,
          text: `${who} wait already running (armed ${formatAge(a.created_at, Date.parse(d.opened_at))} before; ${a.scope ?? "unknown"} scope)`,
          refs: { armId: a.id },
        });
      if (a.created_at >= d.opened_at)
        events.push({
          at: a.created_at,
          kind: "wait_armed",
          source: "wait",
          actor: who,
          text: armText(a, who),
          refs: { armId: a.id },
        });
      if (a.ended_at && a.ended_at <= end)
        events.push({
          at: a.ended_at,
          kind: "wait_ended",
          source: "wait",
          actor: who,
          text: `${who} wait ended: ${a.end_reason}`,
          refs: { armId: a.id },
        });
    }
  }
  if (d.closed_at) {
    events.push({
      at: d.closed_at,
      kind: d.state === "done" ? "delegation_done" : "delegation_closed",
      source: "mailbox",
      actor: d.state === "done" ? "worker" : "parent",
      text: d.state === "done" ? `delegation done (${d.outcome})` : "delegation closed by the parent",
      refs: d.result_id ? { messageId: d.result_id } : {},
    });
  }
  return events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
