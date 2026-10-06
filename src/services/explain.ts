// `agentbus explain`: one chronological account of a delegation (mail, observations, binding changes, wait
// activity) plus evidence-based next steps. It reuses the authoritative derivations (phase, return path,
// handoff, follow-ups) instead of keeping its own state machine, never shows message bodies or raw tool
// input, and changes nothing: no acknowledgement, close, relaunch, resume or spool drain.

import { hasPendingFor, spoolCounts } from "../adapters/claude/spool.ts";
import type { Resolved } from "../config/config.ts";
import type { Db } from "../store/db.ts";
import type { DelegationRow } from "../store/delegations.ts";
import { type MessageRow, messagesInCorrelation } from "../store/messages.ts";
import { latestTurn, type TurnRow } from "../store/observations.ts";
import { getSession, type SessionRow } from "../store/sessions.ts";
import { formatAge } from "../util/misc.ts";
import { type ExplainEvent, explanationTimeline } from "./explain-timeline.ts";
import { type FollowUpCounts, followUpCounts, parentMail } from "./followups.ts";
import { type Handoff, handoffReadiness } from "./handoff.ts";
import { ORPHANED_BACKGROUND_REASON } from "./observe.ts";
import { derivePhase, latestAnswer, type PhaseInfo } from "./phase.ts";
import type { ProbeReport } from "./probe.ts";
import { type ReturnReadiness, returnPathResolver } from "./returnpath.ts";

export type { Actor, ExplainEvent } from "./explain-timeline.ts";

export interface ExplainAction {
  kind:
    | "recover_mail"
    | "answer_question"
    | "inspect_permission"
    | "nudge_worker"
    | "reconcile_launch"
    | "reconcile_ownership"
    | "probe"
    | "decide_retry_or_close"
    | "read_notice"
    | "follow_up_or_close"
    | "rearm_watcher"
    | "refresh_heartbeat"
    | "poll_manually"
    | "drain_events"
    | "review_unhandled"
    | "verify_handoff"
    | "wait";
  title: string;
  why: string;
  commands: string[];
  /** Message IDs the action is about, when no command can show them. */
  ids?: string[];
}

export interface Diagnosis {
  phase: PhaseInfo["phase"];
  outcome: PhaseInfo["outcome"];
  reason: string;
  evidenceAt: string;
  evidenceAge: string;
  /** Plain-language account of what the delegation is waiting on. */
  summary: string;
  stalled: boolean;
  /** Evidence that is missing or could not be verified. */
  uncertain: string[];
  worker: {
    id: string;
    provider: string;
    bound: boolean;
    externalId: string | null;
    shortId: string | null;
    generation: number | null;
    ownerGeneration: number | null;
    /** The worker's own wait for this request (after a question): armed, not_armed, owner_lost, unverified. */
    wait: Pick<ReturnReadiness, "readiness" | "reason" | "evidenceAt"> | null;
  };
  turn: {
    id: string;
    kind: TurnRow["kind"];
    origin: TurnRow["origin"];
    state: TurnRow["state"];
    generation: number;
    current: boolean;
    startedAt: string | null;
    endedAt: string | null;
    backgroundRunning: number | null;
    scheduledWakeups: number | null;
    permissionAt: string | null;
    tracking: TurnRow["tracking"];
    trackingReason: string | null;
  } | null;
  pendingQuestion: PhaseInfo["pendingQuestion"];
  /** The parent's unacknowledged mail in this delegation. */
  parentInbox: { pending: number; unseen: number; messageIds: string[] };
  followUps: FollowUpCounts;
  returnPath: ReturnReadiness;
  handoff: Handoff;
  spool: { backlog: number; quarantined: number; forWorker: boolean };
}

export interface Explanation {
  diagnosis: Diagnosis;
  timeline: { events: ExplainEvent[]; total: number; shown: number; omitted: number; limit: number };
  actions: ExplainAction[];
  probe: ProbeReport | null;
}

/** Evidence older than this, while the worker is said to be working, is worth a probe. */
const QUIET_MS = 30 * 60_000;

export function explainDelegation(
  db: Db,
  paths: Resolved,
  d: DelegationRow,
  opts: { limit: number; probe: ProbeReport | null },
): Explanation {
  const now = Date.now();
  const phase = derivePhase(db, d);
  const parent = getSession(db, d.parent_id);
  const worker = getSession(db, d.worker_id);
  const resolve = returnPathResolver(db, now);
  const returnPath = parent ? resolve(parent, d) : unknownReturnPath();
  const msgs = messagesInCorrelation(db, d.request_id);
  const followUps = followUpCounts(parentMail(db, d));
  const turn = latestTurn(db, d.request_id);
  const binding = worker ? (JSON.parse(worker.adapter_binding) as Record<string, unknown>) : {};
  const workerWait = worker && phaseNeedsWorkerWait(phase, msgs, d) ? resolve(worker, d, true) : null;
  const inbox = msgs.filter((m) => m.to_id === d.parent_id && !m.acknowledged_at);
  const spool = spoolCounts(paths);
  const handoff = handoffReadiness(db, d);

  const diagnosis: Diagnosis = {
    phase: phase.phase,
    outcome: phase.outcome,
    reason: phase.reason,
    evidenceAt: phase.evidenceAt,
    evidenceAge: formatAge(phase.evidenceAt, now),
    summary: "",
    stalled: false,
    uncertain: [],
    worker: {
      id: d.worker_id,
      provider: worker?.provider ?? "unknown",
      bound: !!worker?.external_id,
      externalId: worker?.external_id ?? null,
      shortId: typeof binding.shortId === "string" ? binding.shortId : null,
      generation: worker?.generation ?? null,
      ownerGeneration: worker?.owner_generation ?? null,
      wait: workerWait
        ? { readiness: workerWait.readiness, reason: workerWait.reason, evidenceAt: workerWait.evidenceAt }
        : null,
    },
    turn: turn
      ? {
          id: turn.id,
          kind: turn.kind,
          origin: turn.origin,
          state: turn.state,
          generation: turn.generation,
          current: !!worker && worker.generation === turn.generation,
          startedAt: turn.started_at,
          endedAt: turn.ended_at,
          backgroundRunning: turn.bg_running,
          scheduledWakeups: turn.crons,
          permissionAt: turn.permission_at,
          tracking: turn.tracking,
          trackingReason: turn.tracking_reason,
        }
      : null,
    pendingQuestion: phase.pendingQuestion,
    parentInbox: {
      pending: inbox.length,
      unseen: inbox.filter((m) => !m.seen_at).length,
      messageIds: inbox.slice(0, 20).map((m) => m.id),
    },
    followUps,
    returnPath,
    handoff,
    spool: {
      ...spool,
      forWorker:
        !!worker?.external_id && worker.provider === "claude" && hasPendingFor(paths, worker.external_id),
    },
  };
  const { summary, stalled } = describe(diagnosis, d, msgs, now);
  diagnosis.summary = summary;
  diagnosis.stalled = stalled;
  diagnosis.uncertain = uncertainties(diagnosis, d, opts.probe, now);

  const events = explanationTimeline(db, d, msgs, worker, now);
  const shown = events.slice(Math.max(0, events.length - opts.limit));
  return {
    diagnosis,
    timeline: {
      events: shown,
      total: events.length,
      shown: shown.length,
      omitted: events.length - shown.length,
      limit: opts.limit,
    },
    actions: nextActions(diagnosis, d, msgs, parent),
    probe: opts.probe,
  };
}

function unknownReturnPath(): ReturnReadiness {
  return {
    strategy: "manual",
    status: "unknown",
    readiness: "unverified",
    reason: "parent session not found",
    evidenceAt: null,
    source: "none",
    watcher: null,
    reported: null,
  };
}

/** The worker's own wait matters once it asked: it delivers the answer. */
function phaseNeedsWorkerWait(p: PhaseInfo, msgs: MessageRow[], d: DelegationRow): boolean {
  if (d.state !== "open") return false;
  return p.phase === "question" || (p.phase === "pending" && latestAnswer(msgs, d) !== null);
}

function describe(g: Diagnosis, d: DelegationRow, msgs: MessageRow[], now: number) {
  const age = (iso: string | null | undefined) => formatAge(iso, now);
  const quiet = now - Date.parse(g.evidenceAt) > QUIET_MS;
  switch (g.phase) {
    case "done":
      return {
        stalled: false,
        summary: `Finished: the worker published result/${g.outcome} ${age(d.closed_at)} ago.`,
      };
    case "closed":
      return { stalled: false, summary: `Closed by the parent without a result ${age(d.closed_at)} ago.` };
    case "question":
      return {
        stalled: true,
        summary: `Waiting on the parent: question ${g.pendingQuestion?.id} has been unanswered for ${age(g.evidenceAt)}.`,
      };
    case "permission":
      return {
        stalled: true,
        summary: `Waiting on the user: a provider permission prompt was observed ${age(g.turn?.permissionAt)} ago and nothing since shows it was resolved.`,
      };
    case "pending": {
      const answer = latestAnswer(msgs, d);
      if (answer && g.reason.startsWith("answer delivered")) {
        return {
          stalled: true,
          summary: `Waiting on the worker: answer ${answer.id} reached the mailbox ${age(answer.created_at)} ago, but no new worker turn has started.`,
        };
      }
      if (!g.worker.bound) {
        return {
          stalled: true,
          summary: `Not launched or not claimed: no native session is bound to the worker ${age(d.opened_at)} after the delegation opened.`,
        };
      }
      return {
        stalled: quiet,
        summary: `The worker session is bound, but no turn bound to this request has been observed (${age(g.evidenceAt)}).`,
      };
    }
    case "working":
      return {
        stalled: false,
        summary: `Working: ${g.reason}; latest evidence ${age(g.evidenceAt)} ago${quiet ? " (quiet for a while; a probe can confirm the owner is alive)" : ""}.`,
      };
    case "idle":
      return {
        stalled: true,
        summary: `The worker's turn ended ${age(g.turn?.endedAt)} ago without a result.`,
      };
    case "interrupted":
      return { stalled: true, summary: `Interrupted: ${g.reason}.` };
    case "unknown":
      return { stalled: true, summary: `Tracking is uncertain: ${g.reason}. Unknown is not stopped.` };
  }
}

function uncertainties(g: Diagnosis, d: DelegationRow, probe: ProbeReport | null, now: number): string[] {
  const out: string[] = [];
  if (d.state !== "open") {
    if (g.phase === "done" && !g.handoff.ready) out.push(`handoff not ready: ${g.handoff.reason}`);
    return out;
  }
  if (g.phase === "unknown") out.push(g.reason);
  if (g.phase === "permission")
    out.push("a permission request is last-known state; it may have been resolved since");
  if (g.turn && g.turn.backgroundRunning === null && g.turn.state === "finished")
    out.push("the latest Stop did not report its background task list");
  if (g.returnPath.status === "unknown")
    out.push(`return path ${g.returnPath.readiness}: ${g.returnPath.reason}`);
  if (g.worker.wait?.readiness === "unverified") out.push(`worker wait: ${g.worker.wait.reason}`);
  if (g.spool.backlog > 0)
    out.push(`${g.spool.backlog} captured hook event(s) are queued and not yet ingested`);
  if (!probe && g.phase === "working" && now - Date.parse(g.evidenceAt) > QUIET_MS)
    out.push(`no new evidence for ${formatAge(g.evidenceAt, now)}; liveness was not probed`);
  if (probe && (probe.evidence === "probe_failed" || probe.evidence === "tracking_lost"))
    out.push(`probe: ${probe.reason}`);
  return out;
}

const cmd = (...parts: string[]) => `agentbus ${parts.join(" ")}`;

function nextActions(
  g: Diagnosis,
  d: DelegationRow,
  msgs: MessageRow[],
  parent: SessionRow | null,
): ExplainAction[] {
  const req = d.request_id;
  const out: ExplainAction[] = [];
  const add = (a: ExplainAction) => out.push(a);
  const claude = g.worker.provider === "claude";

  if (g.parentInbox.pending > 0) {
    add({
      kind: "recover_mail",
      title: `Handle ${g.parentInbox.pending} unacknowledged message(s) for you in this delegation`,
      why: `${g.parentInbox.unseen} never delivered by a wait; acknowledgement is how you accept responsibility`,
      commands: [cmd("read", "--correlation", req, "--json"), cmd("ack", "<message-id>...")],
    });
  }
  if (g.spool.backlog > 0) {
    add({
      kind: "drain_events",
      title: "Ingest queued hook events",
      why: `${g.spool.backlog} captured event(s) wait in the spool${g.spool.forWorker ? ", some from this worker" : ""}; phases above do not include them yet`,
      commands: [cmd("event", "drain")],
    });
  }
  const open = d.state === "open";
  const me = parent ? addressOf(parent) : d.parent_id;
  switch (g.phase) {
    case "question": {
      const id = g.pendingQuestion!.id;
      add({
        kind: "answer_question",
        title: `Answer question ${id}`,
        why: "acknowledging a question does not answer it; only a reply to its ID does",
        commands: [cmd("reply", id, "--key", `answer-${id}`, "--file", "answer.md")],
      });
      break;
    }
    case "permission":
      add({
        kind: "inspect_permission",
        title: "Show the permission prompt to the user",
        why: "provider permission prompts belong to the user; Agentbus never approves them",
        commands: claude && g.worker.shortId ? [`claude attach ${g.worker.shortId}`] : [],
      });
      break;
    case "pending": {
      if (latestAnswer(msgs, d) && g.reason.startsWith("answer delivered")) {
        if (g.worker.wait?.readiness === "armed") {
          add({
            kind: "wait",
            title: "Wait for the worker's own wait to deliver the answer",
            why: `its wait is armed: ${g.worker.wait.reason}`,
            commands: [],
          });
        } else {
          add(
            workerNudge(
              g,
              g.worker.wait
                ? `the worker's wait is ${g.worker.wait.readiness}: ${g.worker.wait.reason}`
                : "no worker wait is known",
            ),
          );
        }
      } else if (!g.worker.bound) {
        add({
          kind: "reconcile_launch",
          title: "Reconcile the launch before doing anything else",
          why: "no native session claimed this request; a crash after spawning needs reconciliation, never a second launch",
          commands: [
            claude ? "claude agents --all --json" : "check the launcher's run directory and state.json",
            cmd("session", "bind", d.worker_id, "--external-id", "<native-uuid>"),
          ],
        });
      } else {
        add(probeAction(req, "bound session, but no bound turn observed"));
      }
      break;
    }
    case "interrupted":
      add({
        kind: "decide_retry_or_close",
        title: "Decide: retry with a fresh request, or close",
        why: g.reason,
        commands: [cmd("read", "--correlation", req, "--type", "notice", "--json"), cmd("close", req)],
      });
      break;
    case "unknown": {
      const orphaned = g.turn?.trackingReason === ORPHANED_BACKGROUND_REASON;
      const superseded = g.reason.startsWith("binding superseded");
      if (orphaned) add(workerNudge(g, "a restarted owner orphaned the worker's background wait"));
      else if (superseded) {
        add({
          kind: "reconcile_ownership",
          title: "Find out who is driving the worker session now",
          why: "unrelated input started a new turn in the worker session; later activity is not attributed to this delegation. Do not take over its files",
          commands: claude && g.worker.shortId ? [`claude attach ${g.worker.shortId}`] : [],
        });
      } else add(probeAction(req, g.reason));
      break;
    }
    case "idle":
      add({
        kind: "read_notice",
        title: "Read the worker's final message",
        why: "a finished turn is not a result; the notice carries what the worker said",
        commands: [cmd("read", "--correlation", req, "--type", "notice", "--json")],
      });
      add({
        kind: "follow_up_or_close",
        title: "Follow up or close",
        why:
          g.followUps.pending > 0
            ? `${g.followUps.pending} follow-up(s) are unacknowledged; an idle worker is not woken by mail`
            : "the worker ended its turn without publishing a result",
        commands: [
          cmd("followup", req, "--summary", '"<one line>"', "--file", "followup.md"),
          cmd("close", req),
        ],
      });
      if (g.followUps.pending > 0)
        add(workerNudge(g, "an idle worker does not see new mail until something starts a turn"));
      break;
    case "working":
      if (g.followUps.unseen > 0 && !claude) {
        add({
          kind: "wait",
          title: "Wait: the worker checks for follow-ups at milestones and before its result",
          why: `${g.followUps.unseen} follow-up(s) not shown yet; a success result is refused until they are acknowledged`,
          commands: [],
        });
      } else if (!g.uncertain.some((u) => u.startsWith("no new evidence"))) {
        add({ kind: "wait", title: "Nothing to do: the worker is working", why: g.reason, commands: [] });
      } else add(probeAction(req, "no new evidence for a while"));
      break;
    case "done":
      if (g.followUps.unhandled > 0) {
        add({
          kind: "review_unhandled",
          title: `Review ${g.followUps.unhandled} follow-up(s) the worker never acknowledged`,
          why: `the result/${g.outcome} closed the delegation without handling them; send what still matters as a new request`,
          // The parent cannot read its own sent mail; the IDs identify what to resend.
          commands: [],
          ids: g.followUps.unhandledIds,
        });
      }
      if (!g.handoff.ready) {
        add({
          kind: "verify_handoff",
          title: "Verify the worker is idle before taking over its files",
          why: `handoff not ready: ${g.handoff.reason}; probes cover open delegations only, so check the provider directly`,
          commands: claude ? ["claude agents --all --json"] : ["check the launcher's run state (state.json)"],
        });
      }
      break;
    case "closed":
      break;
  }
  if (open) {
    const rp = g.returnPath;
    if (rp.status !== "ready") {
      if (rp.strategy === "heartbeat") {
        add({
          kind: "refresh_heartbeat",
          title: rp.readiness === "stale" ? "Refresh or recreate the heartbeat" : "Set up the heartbeat",
          why:
            rp.readiness === "stale"
              ? `${rp.reason}; each heartbeat run should check in first`
              : `${rp.reason}; create or reuse one heartbeat, then record it`,
          commands:
            rp.readiness === "stale"
              ? [cmd("session", "update", me, "--refresh")]
              : [
                  `${cmd("session", "update", me, "--binding-file", "-")} <<< '{"strategy":"heartbeat","status":"ready","handle":"<automation-id>","interval":"5m"}'`,
                ],
        });
      } else if (rp.strategy === "background_wait") {
        add({
          kind: "rearm_watcher",
          title: "Re-arm the parent watcher (as a background command)",
          why:
            rp.readiness === "owner_lost"
              ? `${rp.reason}; --replace retires the orphan before it consumes mail`
              : rp.reason,
          commands: [cmd("wait", "--replace", "--timeout", "30m", "--probe", "60s", "--json")],
        });
      } else {
        add({
          kind: "poll_manually",
          title: "Poll for mail",
          why: rp.reason,
          commands: [cmd("read", "--json")],
        });
      }
    }
  }
  if (out.length === 0)
    add({ kind: "wait", title: "Nothing to do", why: "no outstanding evidence needs action", commands: [] });
  return out;
}

const addressOf = (s: SessionRow) => (s.external_id ? `${s.provider}:${s.external_id}` : s.id);

function probeAction(req: string, why: string): ExplainAction {
  return {
    kind: "probe",
    title: "Probe the worker's liveness",
    why: `${why}; a probe records positive death as interrupted and never treats a failed probe as death`,
    commands: [cmd("explain", req, "--probe")],
  };
}

function workerNudge(g: Diagnosis, why: string): ExplainAction {
  const claude = g.worker.provider === "claude";
  return {
    kind: "nudge_worker",
    title: claude
      ? "Nudge the worker through its provider to run its contract's read command"
      : "Resume the worker's thread through its launcher, after confirming the previous run stopped",
    why,
    commands: claude
      ? ["SendMessage to the worker session: run your Agentbus contract's read command"]
      : [`spawn.sh --resume ${g.worker.externalId ?? "<thread-id>"} -f followup.md`],
  };
}
