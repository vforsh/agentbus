// Read-only host evidence. A new CLI process is never evidence of a Desktop restart.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { livenessAll, type ProcessIdentity } from "../../src/adapters/process.ts";

export interface HostEvidence {
  capturedAt: string;
  os: string;
  bun: string;
  pathCli: string;
  bundledCli: string | null;
  appVersion: string | null;
  appBuild: string | null;
  appPath: string;
  app: ProcessIdentity;
  owner: ProcessIdentity;
}

function output(argv: string[]): string {
  const r = Bun.spawnSync(argv, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (r.exitCode !== 0) throw new Error(`${argv[0]}: ${r.stderr.toString().trim() || r.exitCode}`);
  return r.stdout.toString().trim();
}

function optional(argv: string[]): string | null {
  try {
    return output(argv);
  } catch {
    return null;
  }
}

export function captureHost(): HostEvidence {
  if (process.platform !== "darwin") throw new Error("Live Desktop evidence requires macOS");
  const rows = new Map<number, { ppid: number; start: string; command: string }>();
  for (const line of output(["ps", "-A", "-o", "pid=,ppid=,lstart=,comm="]).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), start: m[3]!, command: m[4]! });
  }
  let owner: ProcessIdentity | null = null;
  for (let pid = process.ppid, depth = 0; pid > 1 && depth < 12; depth++) {
    const row = rows.get(pid);
    if (!row) break;
    if (row.command.includes("/codex-cli/") && row.command.endsWith("/codex")) {
      owner = { pid, start: row.start };
    }
    const match = /^(.*\/(?:ChatGPT|Codex)\.app)\/Contents\/MacOS\/[^/]+$/.exec(row.command);
    if (match && owner) {
      const appPath = match[1]!;
      const plist = join(appPath, "Contents/Info.plist");
      const bundled = join(appPath, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
      return {
        capturedAt: new Date().toISOString(),
        os: `${output(["sw_vers", "-productVersion"])} ${process.arch}`,
        bun: Bun.version,
        pathCli: output(["codex", "--version"]),
        bundledCli: existsSync(bundled) ? optional([bundled, "--version"]) : null,
        appVersion: optional(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString", plist]),
        appBuild: optional(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleVersion", plist]),
        appPath,
        app: { pid, start: row.start },
        owner,
      };
    }
    pid = row.ppid;
  }
  throw new Error("Cannot tie this tool process to the original Desktop app owner; no live evidence");
}

export function restarted(before: HostEvidence, after: HostEvidence): boolean {
  const changed = before.app.pid !== after.app.pid || before.app.start !== after.app.start;
  return changed && before.appPath === after.appPath && livenessAll([before.app])[0] === "dead";
}

/** Tools can emit prose before their JSON receipt; keep only a real structured payload. */
export function toolData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Expected a saved tool JSON receipt");
  const v = value as Record<string, unknown>;
  if (v.isError === true) throw new Error("The saved tool call failed");
  if (Array.isArray(v.content)) {
    for (const block of v.content) {
      if (block?.type !== "text" || !block.text.trim().startsWith("{")) continue;
      return toolData(JSON.parse(block.text));
    }
    throw new Error("Tool receipt has no structured payload; rendered cards are not metadata");
  }
  return v;
}

export function automationData(value: unknown): Record<string, unknown> {
  const data = toolData(value);
  const nested = data.automation ?? data.data;
  return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : data;
}
