// User-level Claude hook installation: idempotent merge into ~/.claude/settings.json that preserves
// unrelated entries, writes a private backup, and refuses malformed or concurrently edited files.

import { readFileSync, statSync } from "node:fs";
import type { Resolved } from "../../config/config.ts";
import { shellQuote } from "../../config/config.ts";
import { conflict, failure } from "../../errors.ts";
import { fileExists, modeOf, writeFileAtomic } from "../../util/fsx.ts";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;
export const HOOK_MARKER = "# agentbus-hook v1";

type Json = Record<string, unknown>;

/** Guarded shell command: a missing runtime or unmounted checkout is a silent no-op; always exits 0. */
export function hookCommand(paths: Resolved): string {
  const bun = shellQuote(process.execPath);
  const bin = shellQuote(paths.binPath);
  return (
    `[ -x ${bun} ] && [ -f ${bin} ] && ${bun} ${bin} --state-dir ${shellQuote(paths.stateDir)} ` +
    `--config ${shellQuote(paths.configPath)} event ingest --provider claude --source hook >/dev/null 2>&1; exit 0 ${HOOK_MARKER}`
  );
}

export function hookEntry(paths: Resolved, event: string): Json {
  return { type: "command", command: hookCommand(paths), timeout: event === "SessionEnd" ? 5 : 10 };
}

const isOurs = (h: unknown): boolean =>
  !!h &&
  typeof h === "object" &&
  typeof (h as Json).command === "string" &&
  ((h as Json).command as string).includes(HOOK_MARKER);

interface Loaded {
  text: string | null;
  json: Json;
  mtimeMs: number | null;
}

export function loadSettings(path: string): Loaded {
  if (!fileExists(path)) return { text: null, json: {}, mtimeMs: null };
  const text = readFileSync(path, "utf8");
  let json: unknown;
  try {
    json = text.trim() === "" ? {} : JSON.parse(text);
  } catch (err) {
    throw failure(
      "settings_invalid",
      `Claude settings ${path} is not valid JSON (${(err as Error).message}); fix it before installing hooks`,
    );
  }
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw failure("settings_invalid", `Claude settings ${path} is not a JSON object`);
  if (
    (json as Json).hooks !== undefined &&
    (typeof (json as Json).hooks !== "object" || Array.isArray((json as Json).hooks))
  ) {
    throw failure("settings_invalid", `"hooks" in ${path} is not an object`);
  }
  return { text, json: json as Json, mtimeMs: statSync(path).mtimeMs };
}

/** Removes every Agentbus-owned hook; groups and event arrays emptied by that removal are dropped too. */
function strip(settings: Json): { json: Json; removed: number } {
  const json = structuredClone(settings);
  const hooks = (json.hooks ?? {}) as Json;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!g || typeof g !== "object" || !Array.isArray((g as Json).hooks)) {
        kept.push(g);
        continue;
      }
      const inner = (g as Json).hooks as unknown[];
      const remaining = inner.filter((h) => !isOurs(h));
      removed += inner.length - remaining.length;
      if (remaining.length === inner.length) kept.push(g);
      else if (remaining.length > 0) kept.push({ ...(g as Json), hooks: remaining });
    }
    if (kept.length === 0 && groups.length > 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (json.hooks !== undefined) json.hooks = hooks;
  return { json, removed };
}

export function planInstall(settings: Json, paths: Resolved): { json: Json; changed: boolean } {
  const { json } = strip(settings);
  const hooks = (json.hooks ?? {}) as Json;
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...groups, { hooks: [hookEntry(paths, event)] }];
  }
  json.hooks = hooks;
  return { json, changed: JSON.stringify(json) !== JSON.stringify(settings) };
}

export function planUninstall(settings: Json): { json: Json; changed: boolean; removed: number } {
  const { json, removed } = strip(settings);
  return { json, changed: removed > 0, removed };
}

export interface HookStatus {
  settingsPath: string;
  installed: boolean;
  current: boolean;
  events: Record<string, { entries: number; current: boolean; pinnedStateDir: string | null }>;
}

export function hookStatus(paths: Resolved): HookStatus {
  const loaded = loadSettings(paths.claudeSettingsPath);
  const hooks = (loaded.json.hooks ?? {}) as Json;
  const expected = hookCommand(paths);
  const events: HookStatus["events"] = {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as Json[]) : [];
    const ours = groups.flatMap((g) => (Array.isArray(g?.hooks) ? (g.hooks as Json[]) : [])).filter(isOurs);
    const pinned =
      ours.map((h) => /--state-dir ('(?:[^']|'\\'')*'|\S+)/.exec(h.command as string)?.[1] ?? null)[0] ??
      null;
    events[event] = {
      entries: ours.length,
      current: ours.length === 1 && ours[0]!.command === expected,
      pinnedStateDir: pinned ? pinned.replace(/^'|'$/g, "").replace(/'\\''/g, "'") : null,
    };
  }
  const all = Object.values(events);
  return {
    settingsPath: paths.claudeSettingsPath,
    installed: all.every((e) => e.entries > 0),
    current: all.every((e) => e.current),
    events,
  };
}

/** Writes the new settings after a backup, verifying the file did not change since it was read. */
export function applySettings(path: string, before: Loaded, json: Json): { backupPath: string | null } {
  let backupPath: string | null = null;
  if (before.text !== null) {
    backupPath = `${path}.agentbus-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    writeFileAtomic(backupPath, before.text, 0o600);
  }
  const now = fileExists(path) ? readFileSync(path, "utf8") : null;
  if (now !== before.text) {
    throw conflict(
      "settings_changed",
      `Claude settings ${path} changed while Agentbus was editing it; nothing was written`,
    );
  }
  writeFileAtomic(path, `${JSON.stringify(json, null, 2)}\n`, modeOf(path) ?? 0o600);
  return { backupPath };
}
