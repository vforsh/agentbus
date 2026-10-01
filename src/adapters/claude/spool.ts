// Event spool: captured hook events that could not commit are written here and drained later.
// Complete files only appear through atomic rename; temp files are ignored; deletion follows commit.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Resolved } from "../../config/config.ts";
import { isBusyError } from "../../errors.ts";
import type { Db } from "../../store/db.ts";
import { ensurePrivateDir, writeFileAtomic } from "../../util/fsx.ts";
import { nowIso } from "../../util/misc.ts";
import { type CapturedClaudeEvent, CLAUDE_SOURCE_SCHEMA, ingestClaudeEvent } from "./events.ts";

const MAX_SPOOL_FILE = 4 * 1024 * 1024;
const DRAIN_BATCH = 100;

/** Short, non-reversible session tag in spool file names, so ordering checks need no file reads. */
const sessionTag = (nativeSid: string): string =>
  createHash("sha256").update(nativeSid).digest("hex").slice(0, 16);

export function spoolEvent(paths: Resolved, ev: CapturedClaudeEvent): string {
  ensurePrivateDir(paths.spoolDir);
  const sid = typeof ev.payload.session_id === "string" ? ev.payload.session_id : "";
  const name = `${String(Date.parse(ev.capturedAt)).padStart(15, "0")}-${sessionTag(sid)}-${ev.sourceEventId}.json`;
  const path = join(paths.spoolDir, name);
  writeFileAtomic(path, JSON.stringify(ev));
  return path;
}

export function listSpool(paths: Resolved): string[] {
  try {
    return readdirSync(paths.spoolDir)
      .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
      .sort();
  } catch {
    return [];
  }
}

export function hasPendingFor(paths: Resolved, nativeSid: string): boolean {
  const tag = `-${sessionTag(nativeSid)}-`;
  return listSpool(paths).some((f) => f.includes(tag));
}

export function spoolCounts(paths: Resolved): { backlog: number; quarantined: number } {
  let quarantined = 0;
  try {
    quarantined = readdirSync(join(paths.spoolDir, "quarantine")).filter((f) => f.endsWith(".json")).length;
  } catch {}
  return { backlog: listSpool(paths).length, quarantined };
}

/** Payload-free local diagnostics, bounded to about 1 MiB. */
export function diag(paths: Resolved, line: string): void {
  try {
    ensurePrivateDir(paths.logsDir);
    const file = join(paths.logsDir, "hooks.log");
    try {
      if (statSync(file).size > 1024 * 1024) truncateSync(file, 0);
    } catch {}
    appendFileSync(file, `${nowIso()} ${line}\n`, { mode: 0o600 });
  } catch {}
}

function quarantine(paths: Resolved, file: string, reason: string): void {
  const qdir = join(paths.spoolDir, "quarantine");
  try {
    mkdirSync(qdir, { recursive: true, mode: 0o700 });
    renameSync(join(paths.spoolDir, file), join(qdir, file));
  } catch {}
  diag(paths, `spool quarantine file=${file} reason=${reason}`);
}

function parseSpooled(text: string): CapturedClaudeEvent | null {
  try {
    const ev = JSON.parse(text) as CapturedClaudeEvent;
    if (
      ev?.schemaVersion !== 1 ||
      ev.provider !== "claude" ||
      ev.sourceSchema !== CLAUDE_SOURCE_SCHEMA ||
      typeof ev.sourceEventId !== "string" ||
      typeof ev.capturedAt !== "string" ||
      !ev.payload ||
      typeof ev.payload !== "object"
    ) {
      return null;
    }
    return ev;
  } catch {
    return null;
  }
}

export interface DrainResult {
  ingested: number;
  duplicates: number;
  ignored: number;
  quarantined: number;
  remaining: number;
  busy: boolean;
}

/** Ingests a bounded batch in capture order; each captured ID ingests once, files are deleted after commit. */
export function drainSpool(db: Db, paths: Resolved, max = DRAIN_BATCH): DrainResult {
  const files = listSpool(paths);
  const result: DrainResult = {
    ingested: 0,
    duplicates: 0,
    ignored: 0,
    quarantined: 0,
    remaining: 0,
    busy: false,
  };
  let processed = 0;
  for (const file of files) {
    if (processed >= max) break;
    processed++;
    const full = join(paths.spoolDir, file);
    let text: string;
    try {
      if (statSync(full).size > MAX_SPOOL_FILE) {
        quarantine(paths, file, "oversized");
        result.quarantined++;
        continue;
      }
      text = readFileSync(full, "utf8");
    } catch {
      continue; // Another drainer removed it.
    }
    const ev = parseSpooled(text);
    if (!ev) {
      quarantine(paths, file, "malformed_or_unsupported");
      result.quarantined++;
      continue;
    }
    try {
      const r = ingestClaudeEvent(db, ev);
      if (r.status === "ingested") result.ingested++;
      else if (r.status === "duplicate") result.duplicates++;
      else result.ignored++;
    } catch (err) {
      if (isBusyError(err)) {
        result.busy = true;
        break;
      }
      quarantine(paths, file, `ingest_error:${(err as Error).message.slice(0, 120).replace(/\s+/g, "_")}`);
      result.quarantined++;
      continue;
    }
    try {
      unlinkSync(full);
    } catch {}
  }
  result.remaining = listSpool(paths).length;
  return result;
}
