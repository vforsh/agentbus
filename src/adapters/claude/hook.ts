// Silent Claude hook entry point: never prints, always exits 0, and writes nothing for unregistered
// sessions. Registered events commit directly or are spooled; an unknown-eligibility outage fails open.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type Resolved, resolvePaths } from "../../config/config.ts";
import { parseContract } from "../../protocol/contract.ts";
import { BODY_LIMIT } from "../../protocol/types.ts";
import { HOOK_BUSY_MS, openStore } from "../../store/db.ts";
import { fileExists, readBoundedStdin } from "../../util/fsx.ts";
import { nowIso, truncateUtf8 } from "../../util/misc.ts";
import {
  type CapturedClaudeEvent,
  CLAUDE_SOURCE_SCHEMA,
  ingestClaudeEvent,
  parseTaskNotification,
  promptText,
  readWaitOrigin,
} from "./events.ts";
import { diag, drainSpool, hasPendingFor, spoolEvent } from "./spool.ts";

const MAX_HOOK_INPUT = 8 * 1024 * 1024;
const SUBSCRIBED = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "SessionEnd",
]);

export interface HookArgs {
  stateDir?: string;
  config?: string;
}

/** Keeps only fields needed to reconstruct bindings; ordinary prompt text and raw tool arguments are dropped. */
export function captureEvent(
  raw: Record<string, unknown>,
  capturedAt: string,
  sessionUuid: string,
): CapturedClaudeEvent {
  const truncated: Record<string, number> = {};
  const bound = (key: string, value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const cut = truncateUtf8(value, BODY_LIMIT);
    if (cut.truncated) truncated[key] = cut.bytes;
    return cut.text;
  };
  const payload: Record<string, unknown> = {};
  for (const key of [
    "session_id",
    "prompt_id",
    "hook_event_name",
    "cwd",
    "source",
    "reason",
    "permission_mode",
    "stop_hook_active",
    "tool_name",
    "tool_use_id",
    "error_type",
    "model",
    "agent_id",
    "agent_type",
  ]) {
    if (raw[key] !== undefined) payload[key] = raw[key];
  }
  if (typeof raw.error_message === "string") payload.error_message = raw.error_message.slice(0, 2000);
  if (raw.last_assistant_message !== undefined)
    payload.last_assistant_message = bound("last_assistant_message", raw.last_assistant_message);
  const prompt = promptText(raw);
  let waitOrigin: CapturedClaudeEvent["waitOrigin"];
  if (prompt) {
    const notification = parseTaskNotification(prompt);
    if (parseContract(prompt) || notification) payload.prompt = bound("prompt", prompt);
    else payload.prompt_bytes = Buffer.byteLength(prompt, "utf8");
    if (notification) waitOrigin = readWaitOrigin(sessionUuid, notification);
  }
  if (Array.isArray(raw.background_tasks)) {
    payload.background_tasks = raw.background_tasks
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => ({ id: t.id, status: t.status, type: t.type }));
  }
  if (Array.isArray(raw.session_crons)) payload.session_crons_count = raw.session_crons.length;
  if (raw.tool_input && typeof raw.tool_input === "object") {
    const input = raw.tool_input as Record<string, unknown>;
    payload.tool_input = {
      ...(typeof input.description === "string" ? { description: input.description.slice(0, 500) } : {}),
      _keys: Object.keys(input).slice(0, 20),
    };
  }
  const ev: CapturedClaudeEvent = {
    schemaVersion: 1,
    sourceEventId: randomUUID(),
    capturedAt,
    provider: "claude",
    source: "hook",
    sourceSchema: CLAUDE_SOURCE_SCHEMA,
    payload,
  };
  if (waitOrigin !== undefined) ev.waitOrigin = waitOrigin;
  if (Object.keys(truncated).length > 0) ev.truncated = truncated;
  return ev;
}

function lookupRegistered(
  paths: Resolved,
  nativeSid: string,
  deadline: number,
): "registered" | "unregistered" | "unknown" {
  let db: Database | null = null;
  try {
    db = new Database(paths.dbPath, { readonly: true, strict: true });
    db.run(`PRAGMA busy_timeout = ${Math.max(1, deadline - Date.now())}`);
    const row = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM sessions WHERE provider = 'claude' AND external_id = ?",
      )
      .get(nativeSid);
    return row ? "registered" : "unregistered";
  } catch {
    return "unknown";
  } finally {
    db?.close();
  }
}

export async function runHook(args: HookArgs): Promise<void> {
  const started = Date.now();
  const deadline = started + HOOK_BUSY_MS;
  let paths: Resolved | null = null;
  try {
    // Oversized input is dropped rather than half-parsed.
    const bytes = await readBoundedStdin(MAX_HOOK_INPUT, "hook payload").catch(() => null);
    if (!bytes) return;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return;
    }
    const event = raw?.hook_event_name;
    const nativeSid = raw?.session_id;
    if (typeof event !== "string" || typeof nativeSid !== "string" || !SUBSCRIBED.has(event)) return;
    const capturedAt = nowIso();
    // Only a syntactically valid contract may be captured before eligibility is known.
    const candidate = event === "UserPromptSubmit" && parseContract(promptText(raw)) !== null;

    paths = resolvePaths({ stateDir: args.stateDir, config: args.config });
    const forceSpool = process.env.AGENTBUS_FAULT_INJECT === "hook-spool";
    const storePresent = fileExists(paths.dbPath);
    // An earlier event of this session still in the spool makes it eligible and fixes ordering: this
    // event may commit only after that one, so it drains first or joins the spool behind it.
    let pending = hasPendingFor(paths, nativeSid);
    if (!pending) {
      const eligibility = storePresent ? lookupRegistered(paths, nativeSid, deadline) : "unknown";
      if (eligibility === "unregistered" && !candidate) return;
      if (eligibility === "unknown" && !candidate) {
        // Eligibility cannot be established: fail open without capturing an unrelated session's payload.
        if (storePresent) diag(paths, `hook observation_gap event=${event} reason=store_unavailable`);
        return;
      }
    }

    const ev = captureEvent(raw, capturedAt, nativeSid);
    if (!forceSpool && storePresent) {
      try {
        const db = openStore(paths, { busyMs: Math.max(1, deadline - Date.now()) });
        try {
          if (pending) {
            drainSpool(db, paths);
            pending = hasPendingFor(paths, nativeSid);
          }
          if (!pending) {
            ingestClaudeEvent(db, ev);
            return;
          }
        } finally {
          db.close();
        }
      } catch (err) {
        diag(
          paths,
          `hook commit_failed event=${event} error=${(err as Error).message.slice(0, 160).replace(/\s+/g, "_")}`,
        );
      }
    }
    try {
      spoolEvent(paths, ev);
    } catch (err) {
      diag(
        paths,
        `hook capture_lost event=${event} error=${(err as Error).message.slice(0, 160).replace(/\s+/g, "_")}`,
      );
    }
  } catch (err) {
    if (paths)
      diag(paths, `hook unexpected error=${(err as Error).message.slice(0, 160).replace(/\s+/g, "_")}`);
  }
}
