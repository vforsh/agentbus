// Claude hook entries. The default mode is per worker: `delegate --to claude` writes a standalone
// settings file that the launcher passes to `claude --bg --settings`, so only Agentbus workers run the
// hooks. The optional user-level install merges the same entries into ~/.claude/settings.json,
// idempotently, with a private backup, refusing malformed or concurrently edited files.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Resolved } from "../../config/config.ts";
import { shellQuote } from "../../config/config.ts";
import { conflict, failure } from "../../errors.ts";
import { workerBinCommand, workerDir } from "../../protocol/contract.ts";
import { fileExists, modeOf, writeFileAtomic } from "../../util/fsx.ts";

export const HOOK_EVENTS = [
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;
export const HOOK_MARKER = "# agentbus-hook v1";

type Json = Record<string, unknown>;

/**
 * Guarded shell command: a missing executable or unmounted checkout is a silent no-op; always exits 0.
 * stdout stays connected for the doorbell's hook decision; the CLI prints nothing else there.
 */
export function hookCommand(paths: Resolved): string {
  const argv = paths.cliArgv;
  const guard = argv
    ? [`[ -x ${shellQuote(argv[0]!)} ]`, ...argv.slice(1).map((a) => `[ -f ${shellQuote(a)} ]`)].join(
        " && ",
      ) + " && "
    : "";
  return (
    `${guard}${paths.cliCommand} --state-dir ${shellQuote(paths.stateDir)} --config ${shellQuote(paths.configPath)} ` +
    `event ingest --provider claude --source hook 2>/dev/null; exit 0 ${HOOK_MARKER}`
  );
}

export function hookEntry(paths: Resolved, event: string): Json {
  return { type: "command", command: hookCommand(paths), timeout: event === "SessionEnd" ? 5 : 10 };
}

/** Standalone settings carrying only the Agentbus hooks, for `claude --settings <file>`. */
export function hooksSettings(paths: Resolved): Json {
  return { hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [hookEntry(paths, e)] }]])) };
}

export const workerSettingsPath = (paths: Resolved, workerId: string): string =>
  join(workerDir(paths.stateDir, workerId), "claude-settings.json");

/**
 * A worker's private settings: the hooks plus permission rules for exactly this Agentbus CLI and, given a
 * worker, its executable, so the contract's commands never stop on a prompt. Other tools keep the session's
 * permission mode.
 */
export function workerSettings(paths: Resolved, workerId?: string): Json {
  const allow = [`Bash(${paths.cliCommand}:*)`];
  if (workerId) allow.push(`Bash(${workerBinCommand(paths.stateDir, workerId)}:*)`);
  return { ...hooksSettings(paths), permissions: { allow } };
}

/** Writes (or rewrites) a settings file atomically; safe to repeat on keyed retries. */
export function writeHooksSettings(path: string, paths: Resolved, settings = workerSettings(paths)): void {
  writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
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
