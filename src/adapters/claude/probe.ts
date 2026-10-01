// Claude probing: one `claude agents --all --json` inventory per probe cycle plus optional job diagnostics.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentRow {
  id: string | null;
  sessionId: string;
  kind: string | null;
  state: string | null;
  status: string | null;
  pid: number | null;
  name: string | null;
  cwd: string | null;
  startedAt: number | null;
}

export type Inventory = { ok: true; rows: AgentRow[] } | { ok: false; error: string };

/** Validates rows, tolerates additive fields and drops rows without identity instead of fabricating state. */
export function parseInventory(text: string): Inventory {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "claude agents returned invalid JSON" };
  }
  if (!Array.isArray(data)) return { ok: false, error: "claude agents did not return an array" };
  const rows: AgentRow[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.sessionId !== "string" || o.sessionId.length === 0) continue;
    rows.push({
      id: typeof o.id === "string" ? o.id : null,
      sessionId: o.sessionId,
      kind: typeof o.kind === "string" ? o.kind : null,
      state: typeof o.state === "string" ? o.state : null,
      status: typeof o.status === "string" ? o.status : null,
      pid: typeof o.pid === "number" && Number.isSafeInteger(o.pid) ? o.pid : null,
      name: typeof o.name === "string" ? o.name : null,
      cwd: typeof o.cwd === "string" ? o.cwd : null,
      startedAt: typeof o.startedAt === "number" ? o.startedAt : null,
    });
  }
  return { ok: true, rows };
}

export function claudeInventory(claudeBin: string, timeoutMs: number): Inventory {
  try {
    const res = Bun.spawnSync([claudeBin, "agents", "--all", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: Math.max(500, timeoutMs),
    });
    if (res.exitCode !== 0) {
      return { ok: false, error: `claude agents exited with status ${res.exitCode ?? "signal"}` };
    }
    return parseInventory(res.stdout.toString());
  } catch (err) {
    return { ok: false, error: `claude agents failed: ${(err as Error).message}` };
  }
}

export interface JobDiagnostics {
  state: string | null;
  detail: string | null;
  needs: unknown;
}

/** Undocumented job state; optional enrichment only, never a lifecycle dependency. */
export function readJobState(jobsDir: string, shortId: string | null): JobDiagnostics | null {
  if (!shortId || !/^[A-Za-z0-9_-]{1,64}$/.test(shortId)) return null;
  try {
    const data = JSON.parse(readFileSync(join(jobsDir, shortId, "state.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return {
      state: typeof data.state === "string" ? data.state : null,
      detail: typeof data.detail === "string" ? data.detail : null,
      needs: data.needs ?? null,
    };
  } catch {
    return null;
  }
}

export const ownerOf = (kind: string | null): "background" | "desktop" | "interactive" | "unknown" =>
  kind === "background" || kind === "desktop" || kind === "interactive" ? kind : "unknown";
