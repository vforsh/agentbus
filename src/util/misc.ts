import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { usageError } from "../errors.ts";

export const nowIso = (): string => new Date().toISOString();

export const newId = (): string => randomUUID();

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: string): boolean => UUID_RE.test(s);

/** Stable JSON: object keys sorted recursively, so equal intents hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const hashIntent = (intent: unknown): string => sha256(canonicalJson(intent));

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses positive durations such as `250ms`, `30s`, `30m`, `2h`, `7d` into milliseconds. */
export function parseDuration(text: string, flag: string): number {
  const m = DURATION_RE.exec(text.trim());
  if (!m)
    throw usageError(`${flag} must be a positive duration such as 500ms, 30s, 30m or 2h`, { value: text });
  const ms = Number(m[1]) * DURATION_UNITS[m[2]!]!;
  if (!Number.isSafeInteger(ms) || ms <= 0) throw usageError(`${flag} must be positive`, { value: text });
  return ms;
}

export function formatAge(fromIso: string | null | undefined, now = Date.now()): string {
  if (!fromIso) return "-";
  const ms = Math.max(0, now - Date.parse(fromIso));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Display path plus resolved real path; `~/dev` and `/workspace` compare equal. */
/**
 * Absolute and real path of a directory. With `allowMissing`, a directory a launcher creates later
 * (for example `claude --worktree`) resolves through its nearest existing ancestor.
 */
export function canonicalDir(
  input: string,
  opts: { allowMissing?: boolean } = {},
): { display: string; real: string } {
  const display = resolve(input);
  try {
    return { display, real: realpathSync(display) };
  } catch {
    if (!opts.allowMissing) throw usageError(`Directory does not exist: ${display}`, { cwd: display });
  }
  let ancestor = dirname(display);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  if (!statSync(ancestor).isDirectory()) throw usageError(`Not a directory: ${ancestor}`, { cwd: display });
  return { display, real: join(realpathSync(ancestor), relative(ancestor, display)) };
}

export function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Single line, at most `max` characters, for tables and derived summaries. */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Truncates text to a UTF-8 byte budget without splitting a code point. */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  let end = buf.length;
  // Step back over a partial multi-byte sequence.
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
  if (end > 0 && buf[end - 1]! >= 0xc0) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true, bytes };
}
