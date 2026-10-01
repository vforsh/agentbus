// Shared renderers for human and plain output.

import pc from "picocolors";
import type { Envelope } from "../protocol/types.ts";
import { type Handoff, handoffReadiness } from "../services/handoff.ts";
import type { PhaseInfo } from "../services/phase.ts";
import type { Db } from "../store/db.ts";
import type { DelegationRow } from "../store/delegations.ts";
import { type MessageRow, toEnvelope } from "../store/messages.ts";
import { displayName, getSession, type Session } from "../store/sessions.ts";
import { formatAge } from "../util/misc.ts";

export function nameOf(db: Db, id: string): string {
  const s = getSession(db, id);
  if (!s) return id.slice(0, 8);
  if (s.provider === "system") return "system:observer";
  return displayName(s);
}

export function envelopes(rows: MessageRow[]): Envelope[] {
  return rows.map(toEnvelope);
}

function kindLabel(e: Envelope): string {
  if (e.type === "notice" && e.notice) return `notice/${e.notice.kind}`;
  if (e.type === "result") return `result/${e.outcome}`;
  return e.type;
}

function receiptLabel(e: Envelope): string {
  if (e.acknowledgedAt) return pc.dim("acked");
  if (e.seenAt) return pc.dim("seen");
  return pc.green("new");
}

export function messagesHuman(db: Db, rows: MessageRow[]): string {
  if (rows.length === 0) return pc.dim("No messages.");
  return rows
    .map((r) => {
      const e = toEnvelope(r);
      const head = `${pc.bold(`#${e.sequence}`)} ${pc.cyan(kindLabel(e))} ${nameOf(db, e.from)} → ${nameOf(db, e.to)} ${receiptLabel(e)}`;
      const meta = pc.dim(
        `id ${e.id}  correlation ${e.correlationId}${e.inReplyTo ? `  reply-to ${e.inReplyTo}` : ""}`,
      );
      const summary = e.summary ? `${pc.bold(e.summary)}\n` : "";
      return `${head}\n${meta}\n${summary}${e.body}`;
    })
    .join("\n\n");
}

export function messagesPlain(rows: MessageRow[]): string[] {
  return rows.map((r) => {
    const e = toEnvelope(r);
    return [
      e.sequence,
      e.id,
      e.type,
      e.from,
      e.to,
      e.correlationId,
      e.outcome ?? e.notice?.kind ?? "-",
      e.summary ?? "-",
    ]
      .map(String)
      .join("\t");
  });
}

export function sessionLine(s: Session): string {
  const labels = Object.entries(s.labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return [s.id, s.provider, s.externalId ?? "pending", s.name ?? "-", labels || "-", s.cwd ?? "-"].join("\t");
}

export interface DelegationView {
  requestId: string;
  name: string;
  workerId: string;
  provider: string;
  /** Native handles for launcher scripts: session UUID, Claude short ID and directory. */
  worker: { externalId: string | null; shortId: string | null; cwd: string | null };
  labels: Record<string, string>;
  state: DelegationRow["state"];
  phase: PhaseInfo["phase"];
  phaseReason: string;
  outcome: PhaseInfo["outcome"];
  evidenceAt: string;
  evidenceAge: string;
  latestSummary: string | null;
  pendingQuestion: PhaseInfo["pendingQuestion"];
  backgroundRunning: number | null;
  tracking: PhaseInfo["tracking"];
  openedAt: string;
  closedAt: string | null;
  returnPath: string;
  returnPathStatus: string;
  handoff: Handoff;
  probe?: unknown;
}

export function delegationView(db: Db, d: DelegationRow, p: PhaseInfo): DelegationView {
  const w = getSession(db, d.worker_id);
  return {
    requestId: d.request_id,
    name: w ? displayName(w) : d.worker_id.slice(0, 8),
    workerId: d.worker_id,
    provider: w?.provider ?? "unknown",
    worker: {
      externalId: w?.external_id ?? null,
      shortId: w ? shortIdOf(w.adapter_binding) : null,
      cwd: w?.cwd ?? null,
    },
    labels: w ? JSON.parse(w.labels) : {},
    state: d.state,
    phase: p.phase,
    phaseReason: p.reason,
    outcome: p.outcome,
    evidenceAt: p.evidenceAt,
    evidenceAge: formatAge(p.evidenceAt),
    latestSummary: p.latestSummary,
    pendingQuestion: p.pendingQuestion,
    backgroundRunning: p.backgroundRunning,
    tracking: p.tracking,
    openedAt: d.opened_at,
    closedAt: d.closed_at,
    returnPath: d.return_path,
    returnPathStatus: d.return_path_status,
    handoff: handoffReadiness(db, d),
  };
}

function shortIdOf(adapterBinding: string): string | null {
  const v = (JSON.parse(adapterBinding) as Record<string, unknown>).shortId;
  return typeof v === "string" ? v : null;
}

const phaseColor = (phase: string): string => {
  switch (phase) {
    case "question":
    case "permission":
      return pc.yellow(phase);
    case "interrupted":
    case "unknown":
      return pc.red(phase);
    case "done":
      return pc.green(phase);
    case "working":
      return pc.cyan(phase);
    default:
      return phase;
  }
};

export function delegationsTable(views: DelegationView[]): string {
  if (views.length === 0) return pc.dim("No delegations.");
  const rows = views.map((v) => [
    v.name,
    v.provider,
    Object.entries(v.labels)
      .map(([k, val]) => `${k}=${val}`)
      .join(",") || "-",
    v.phase + (v.outcome ? `/${v.outcome}` : ""),
    v.evidenceAge,
    v.pendingQuestion?.summary ?? v.latestSummary ?? "-",
  ]);
  const header = ["NAME", "PROVIDER", "LABELS", "PHASE", "AGE", "SUMMARY"];
  const widths = header.map((h, i) => Math.min(40, Math.max(h.length, ...rows.map((r) => r[i]!.length))));
  const fmt = (cells: string[], color = false) =>
    cells
      .map((c, i) => {
        const cut = i < cells.length - 1 && c.length > widths[i]! ? `${c.slice(0, widths[i]! - 1)}…` : c;
        const padded = i < cells.length - 1 ? cut.padEnd(widths[i]!) : cut;
        return color && i === 3 ? padded.replace(cut, phaseColor(cut)) : padded;
      })
      .join("  ");
  return [pc.bold(fmt(header)), ...rows.map((r) => fmt(r, true))].join("\n");
}

export function delegationDetail(v: DelegationView): string {
  const lines = [
    `${pc.bold(v.name)} ${v.requestId}`,
    `phase     ${v.phase}${v.outcome ? `/${v.outcome}` : ""} — ${v.phaseReason} (${v.evidenceAge} ago)`,
    `provider  ${v.provider}  worker ${v.workerId}${v.worker.shortId ? `  short ${v.worker.shortId}` : ""}${v.worker.externalId ? `  native ${v.worker.externalId}` : ""}`,
    ...(v.worker.cwd ? [`cwd       ${v.worker.cwd}`] : []),
    `return    ${v.returnPath} — ${v.returnPathStatus}`,
    `handoff   ${v.handoff.ready ? "ready" : "not ready"} — ${v.handoff.reason}`,
  ];
  if (v.pendingQuestion) lines.push(`question  ${v.pendingQuestion.id} ${v.pendingQuestion.summary ?? ""}`);
  if (v.latestSummary) lines.push(`summary   ${v.latestSummary}`);
  if (v.probe) lines.push(`probe     ${JSON.stringify(v.probe)}`);
  return lines.join("\n");
}

export function delegationsPlain(views: DelegationView[]): string[] {
  return views.map((v) =>
    [
      v.requestId,
      v.name,
      v.provider,
      v.phase,
      v.outcome ?? "-",
      v.evidenceAt,
      v.pendingQuestion?.id ?? "-",
      v.latestSummary ?? "-",
    ].join("\t"),
  );
}
