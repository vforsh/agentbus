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
