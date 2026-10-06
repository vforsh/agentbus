// Process identity: a PID alone is reused by the OS, so liveness compares the recorded start time too.

export interface ProcessIdentity {
  pid: number;
  /** Start time as reported by `ps -o lstart=`, stable for the lifetime of the process. */
  start: string;
}

export type Liveness = "alive" | "dead" | "unknown";

export function processStart(pid: number, timeoutMs = 2000): string | null | "error" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const res = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      env: { ...process.env, LC_ALL: "C" },
    });
    const out = res.stdout.toString().trim();
    if (res.exitCode === 0 && out) return out;
    // ps exits 1 with empty output when no such process exists.
    if (res.exitCode === 1 && !out) return null;
    return "error";
  } catch {
    return "error";
  }
}

export function identify(pid: number): ProcessIdentity | null {
  const start = processStart(pid);
  return start && start !== "error" ? { pid, start } : null;
}

/** Alive only when the PID exists with the same start identity; a failed check is unknown, never dead. */
export function liveness(id: ProcessIdentity | null | undefined, timeoutMs = 2000): Liveness {
  if (!id?.start) return "unknown";
  const start = processStart(id.pid, timeoutMs);
  if (start === "error") return "unknown";
  if (start === null) return "dead";
  return start === id.start ? "alive" : "dead";
}

/**
 * Rows of `ps -o pid=,ppid=,lstart=`; null when ps itself failed (unknown, never "no such process"). Start
 * times are rendered in UTC so a recorder and a checker with different TZ settings agree.
 */
function psRows(args: string[], timeoutMs: number): Map<number, { ppid: number; start: string }> | null {
  try {
    const res = Bun.spawnSync(["ps", "-o", "pid=,ppid=,lstart=", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const out = res.stdout.toString();
    if (res.exitCode !== 0 && !(res.exitCode === 1 && !out.trim())) return null;
    const rows = new Map<number, { ppid: number; start: string }>();
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), start: m[3]! });
    }
    return rows;
  } catch {
    return null;
  }
}

/**
 * The process and up to `depth` ancestors (excluding launchd/init), each with its start identity. A wait
 * records them when armed: its exit re-invokes whoever owns that tree, so an ancestor ending means the
 * owner the wait would notify is gone even if the wait process itself survives as an orphan.
 */
export function lineage(
  pid: number,
  depth: number,
): { self: ProcessIdentity; ancestors: ProcessIdentity[] } | null {
  const rows = psRows(["-A"], 3000);
  const me = rows?.get(pid);
  if (!rows || !me) return null;
  const ancestors: ProcessIdentity[] = [];
  for (let p = me.ppid; p > 1 && ancestors.length < depth; ) {
    const row = rows.get(p);
    if (!row) break;
    ancestors.push({ pid: p, start: row.start });
    p = row.ppid;
  }
  return { self: { pid, start: me.start }, ancestors };
}

/** Liveness of several identities with one `ps` call; every entry is unknown when ps fails. */
export function livenessAll(ids: ProcessIdentity[], timeoutMs = 2000): Liveness[] {
  const valid = ids.filter((id) => Number.isSafeInteger(id.pid) && id.pid > 0 && id.start);
  const rows = valid.length > 0 ? psRows(["-p", valid.map((id) => id.pid).join(",")], timeoutMs) : new Map();
  return ids.map((id) => {
    if (!id.start || !rows) return "unknown";
    const row = rows.get(id.pid);
    if (!row) return "dead";
    return row.start === id.start ? "alive" : "dead";
  });
}
