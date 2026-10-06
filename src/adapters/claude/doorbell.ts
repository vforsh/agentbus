// Claude doorbell: the one place a hook speaks. After a tool call (PostToolUse) or when the worker tries to
// end its turn (Stop), pending parent follow-ups are announced in the worker's context. The bodies stay in
// the mailbox; the announcement names them and the exact commands to read and acknowledge them.

import { Database } from "bun:sqlite";
import type { Resolved } from "../../config/config.ts";
import { workerBinCommand } from "../../protocol/contract.ts";
import { claimFollowUps, type FollowUps, hasFollowUps } from "../../services/followups.ts";
import { openStore } from "../../store/db.ts";
import { fileExists } from "../../util/fsx.ts";
import { diag, errorToken } from "./spool.ts";

export type DoorbellEvent = "PostToolUse" | "Stop";

/** Hook stdout for the event: extra context after a tool result, or a blocked Stop that continues the turn. */
export function ringDoorbell(paths: Resolved, nativeSid: string, event: DoorbellEvent, deadline: number) {
  const followUps = claim(paths, nativeSid, deadline);
  if (!followUps) return null;
  const text = announcement(paths, followUps, event);
  return event === "Stop"
    ? { decision: "block", reason: text }
    : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } };
}

function claim(paths: Resolved, nativeSid: string, deadline: number): FollowUps | null {
  if (!fileExists(paths.dbPath)) return null;
  const busyMs = () => Math.max(1, deadline - Date.now());
  try {
    // Read-only first: most tool calls find nothing, and they must not take the write lock.
    const probe = new Database(paths.dbPath, { readonly: true, strict: true });
    try {
      probe.run(`PRAGMA busy_timeout = ${busyMs()}`);
      if (!hasFollowUps(probe, "claude", nativeSid)) return null;
    } finally {
      probe.close();
    }
    const db = openStore(paths, { busyMs: busyMs() });
    try {
      return claimFollowUps(db, "claude", nativeSid);
    } finally {
      db.close();
    }
  } catch (err) {
    diag(paths, `hook doorbell_failed error=${errorToken(err)}`);
    return null;
  }
}

function announcement(paths: Resolved, f: FollowUps, event: DoorbellEvent): string {
  const ab = workerBinCommand(paths.stateDir, f.workerId);
  const lines = f.messages.map((m) => {
    const gist = (m.summary ?? m.body.split("\n").find((l) => l.trim()) ?? "").trim();
    return `- ${m.id} (${m.type}): ${gist.length > 160 ? `${gist.slice(0, 159)}…` : gist}`;
  });
  return [
    `Agentbus: your parent sent ${f.messages.length} new message(s) for request ${f.requestId}.`,
    "They appear nowhere else in this conversation; read them now and handle them within your task.",
    ...lines,
    `  ${ab} read --from ${f.parentId} --json`,
    `  ${ab} ack ${f.messages.map((m) => m.id).join(" ")}`,
    ...(event === "Stop" ? ["Do this before ending your turn."] : []),
  ].join("\n");
}
