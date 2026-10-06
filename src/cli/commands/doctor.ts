import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { hookStatus } from "../../adapters/claude/settings.ts";
import { spoolCounts } from "../../adapters/claude/spool.ts";
import { buildInfo, executableBuildInfo, sourceFreshness } from "../../build-info.ts";
import { installedBinPath, type Resolved, resolvePaths } from "../../config/config.ts";
import { resolveCallerRef } from "../../services/caller.ts";
import { returnPathResolver } from "../../services/returnpath.ts";
import { readSchemaVersion, SCHEMA_VERSION } from "../../store/db.ts";
import { openDelegationsForParent } from "../../store/delegations.ts";
import { resolveAddress } from "../../store/sessions.ts";
import { fileExists, modeOf } from "../../util/fsx.ts";
import { realOrSelf } from "../../util/misc.ts";
import { action } from "../action.ts";

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  message: string;
  hint?: string;
}

const MIN_BUN = [1, 4, 2];

function versionAtLeast(v: string, min: number[]): boolean {
  const parts = v.split(".").map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i]!;
  }
  return true;
}

/** Read-only readiness checks: never initializes, drains, logs in, starts daemons or edits provider settings. */
function runChecks(opts: { config?: string; stateDir?: string; as?: string }): Check[] {
  const checks: Check[] = [];
  const add = (name: string, status: Status, message: string, hint?: string) =>
    checks.push({ name, status, message, ...(hint ? { hint } : {}) });

  add(
    "runtime",
    versionAtLeast(Bun.version, MIN_BUN) ? "ok" : "fail",
    `bun ${Bun.version} (${Bun.revision.slice(0, 9)})`,
    versionAtLeast(Bun.version, MIN_BUN) ? undefined : `upgrade Bun to ${MIN_BUN.join(".")} or newer`,
  );

  let paths: Resolved;
  try {
    paths = resolvePaths(opts);
    add(
      "config",
      "ok",
      `${paths.configPath} (${fileExists(paths.configPath) ? "present" : "defaults"}; ${paths.configSource})`,
    );
  } catch (err) {
    add("config", "fail", (err as Error).message, "fix or remove the config file");
    return checks;
  }

  const stateMode = modeOf(paths.stateDir);
  if (stateMode === null) add("state_dir", "fail", `${paths.stateDir} does not exist`, "run `agentbus init`");
  else
    add(
      "state_dir",
      stateMode & 0o077 ? "warn" : "ok",
      `${paths.stateDir} (mode ${stateMode.toString(8)})`,
      stateMode & 0o077 ? "chmod 700 the state directory" : undefined,
    );

  if (!fileExists(paths.dbPath)) {
    add("store", "fail", `no mailbox at ${paths.dbPath}`, "run `agentbus init`");
  } else {
    try {
      const db = new Database(paths.dbPath, { readonly: true, strict: true });
      try {
        const version = readSchemaVersion(db);
        const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode;
        const sqlite = db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get()?.v;
        const ok = version === SCHEMA_VERSION && journal === "delete";
        add(
          "store",
          ok ? "ok" : "fail",
          `schema v${version} (supported v${SCHEMA_VERSION}), journal ${journal}, sqlite ${sqlite}`,
          ok ? undefined : version < SCHEMA_VERSION ? "run `agentbus init` to migrate" : "upgrade agentbus",
        );
      } finally {
        db.close();
      }
      const dbMode = modeOf(paths.dbPath) ?? 0;
      if (dbMode & 0o077)
        add("store_mode", "warn", `database mode ${dbMode.toString(8)}`, "chmod 600 the database");
    } catch (err) {
      add("store", "fail", `cannot open mailbox: ${(err as Error).message}`);
    }
  }

  const spool = spoolCounts(paths);
  let spoolHint: string | undefined;
  if (spool.backlog > 0) spoolHint = "run `agentbus event drain`";
  else if (spool.quarantined > 0) spoolHint = `inspect ${join(paths.spoolDir, "quarantine")}`;
  add(
    "spool",
    spoolHint ? "warn" : "ok",
    `${spool.backlog} pending, ${spool.quarantined} quarantined`,
    spoolHint,
  );

  try {
    const log = join(paths.logsDir, "hooks.log");
    if (fileExists(log) && Date.now() - statSync(log).mtimeMs < 24 * 3_600_000) {
      const recent = readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => /capture_lost|observation_gap|commit_failed/.test(l));
      if (recent.length > 0)
        add(
          "hook_capture",
          "warn",
          `${recent.length} degraded hook capture(s) logged in ${log}`,
          "check disk space and store availability",
        );
    }
  } catch {}

  try {
    const hs = hookStatus(paths);
    const pins = Object.values(hs.events)
      .map((e) => e.pinnedStateDir)
      .filter((p): p is string => !!p);
    const mismatch = pins.find((p) => realOrSelf(p) !== realOrSelf(paths.stateDir));
    if (mismatch) {
      add(
        "claude_hooks",
        "fail",
        `hooks pin store ${mismatch}, but this command uses ${paths.stateDir}`,
        "reinstall hooks with the intended --state-dir, or select the pinned store",
      );
    } else if (hs.current) {
      add("claude_hooks", "ok", `user-level hooks installed in ${hs.settingsPath}`);
    } else if (Object.values(hs.events).some((e) => e.entries > 0)) {
      add(
        "claude_hooks",
        "warn",
        `user-level hooks in ${hs.settingsPath} are not current`,
        "run `agentbus hooks claude install` again, or `uninstall` to rely on per-worker hooks",
      );
    } else {
      add(
        "claude_hooks",
        "ok",
        "per-worker hooks (delegate writes a --settings file for each Claude worker)",
      );
    }
  } catch (err) {
    add("claude_hooks", "warn", (err as Error).message);
  }

  const currentBuild = buildInfo();
  add(
    "build",
    "ok",
    `${currentBuild.commit ?? "unknown commit"}${currentBuild.dirty ? " (dirty)" : ""}; source ${currentBuild.sourceHash}; schema v${currentBuild.schemaVersion}; ${currentBuild.compiled ? "compiled" : "source"}`,
  );
  const workerCli = paths.cliArgv ?? [paths.cliCommand];
  const external = workerCli.find((p) => p.startsWith("/Volumes/"));
  const installed = installedBinPath();
  if (external) {
    add(
      "worker_cli",
      "warn",
      `workers run ${external}, on an external volume`,
      "run `bun run upgrade` in the checkout",
    );
  } else if (paths.cliArgv?.length === 1) {
    const binary = paths.cliArgv[0]!;
    const identity =
      currentBuild.compiled && realOrSelf(binary) === realOrSelf(process.execPath)
        ? currentBuild
        : executableBuildInfo(binary);
    if (!identity) {
      add(
        "worker_cli",
        "warn",
        `workers run ${binary}; build identity unavailable`,
        "run `bun run upgrade` to install an identifiable build",
      );
    } else {
      // A source invocation compares against its own checkout; a standalone executable can inspect
      // its recorded checkout when mounted, but remains usable when that checkout is unavailable.
      const freshness = !currentBuild.compiled
        ? identity.sourceHash === currentBuild.sourceHash
          ? "current"
          : "stale"
        : sourceFreshness(identity);
      const compatible = identity.schemaVersion === SCHEMA_VERSION;
      add(
        "worker_cli",
        !compatible ? "fail" : freshness === "current" ? "ok" : "warn",
        `workers run ${binary}; commit ${identity.commit ?? "unknown"}; source ${identity.sourceHash}; schema v${identity.schemaVersion}; checkout ${freshness}`,
        !compatible || freshness === "stale"
          ? "run `bun run upgrade` in the intended checkout"
          : freshness === "unavailable"
            ? "checkout unavailable; build identity is recorded, freshness cannot be checked"
            : undefined,
      );
    }
  } else {
    add(
      "worker_cli",
      "warn",
      `workers run ${paths.cliCommand}; custom/source command, compiled identity not verified`,
      `the standard executable is ${installed}`,
    );
  }

  for (const [name, bin] of [
    ["claude_cli", paths.claudeBin],
    ["codex_cli", paths.codexBin],
  ] as const) {
    const found = bin.includes("/") ? (fileExists(bin) ? bin : null) : Bun.which(bin);
    add(
      name,
      found ? "ok" : "warn",
      found ? found : `${bin} not found`,
      found ? undefined : `set ${name === "claude_cli" ? "claudeBin" : "codexBin"} in config`,
    );
  }

  try {
    const ref = resolveCallerRef(opts.as);
    add(
      "caller",
      ref ? "ok" : "warn",
      ref ? `${ref.address} (from ${ref.detail})` : "no caller identity in this environment",
      ref ? undefined : "pass --as or set AGENTBUS_SESSION_ID",
    );
    if (ref && fileExists(paths.dbPath)) {
      const check = returnPathCheck(paths, ref.address);
      if (check) add("return_path", check.status, check.message, check.hint);
    }
  } catch (err) {
    add("caller", "warn", (err as Error).message);
  }
  return checks;
}

/** The caller's current return path as a parent of open delegations; read-only (one `ps` call at most). */
function returnPathCheck(paths: Resolved, address: string): Omit<Check, "name"> | null {
  const db = new Database(paths.dbPath, { readonly: true, strict: true });
  try {
    if (readSchemaVersion(db) !== SCHEMA_VERSION) return null;
    const me = resolveAddress(db, address);
    if (!me) return null;
    const open = openDelegationsForParent(db, me.id);
    if (open.length === 0) return { status: "ok", message: "no open delegations as a parent" };
    const resolve = returnPathResolver(db);
    const worst = open.map((d) => resolve(me, d)).find((r) => r.status !== "ready") ?? resolve(me, open[0]!);
    const message = `${open.length} open delegation(s); ${worst.strategy} ${worst.readiness}: ${worst.reason}`;
    if (worst.status === "ready") return { status: "ok", message };
    const hint =
      worst.strategy === "heartbeat"
        ? "have each heartbeat run `agentbus session update <me> --refresh`, or recreate the heartbeat; otherwise poll with `agentbus read`"
        : worst.strategy === "background_wait"
          ? "arm one background `agentbus wait --replace --timeout 30m --probe 60s --json`"
          : "poll with `agentbus read`";
    return { status: "warn", message, hint };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

const STATUS_TAG: Record<Status, () => string> = {
  ok: () => pc.green("OK  "),
  warn: () => pc.yellow("WARN"),
  fail: () => pc.red("FAIL"),
};

function overallStatus(checks: Check[]): Status {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .alias("check")
    .description("Read-only readiness checks with remediation hints")
    .action(
      action((ctx) => {
        const checks = runChecks({ config: ctx.opts.config, stateDir: ctx.opts.stateDir, as: ctx.opts.as });
        const status = overallStatus(checks);
        if (status === "fail") ctx.exitCode = 1;
        ctx.emit(
          { status, checks },
          () =>
            checks
              .map(
                (c) =>
                  `${STATUS_TAG[c.status]()} ${c.name.padEnd(13)} ${c.message}${c.hint ? pc.dim(` — ${c.hint}`) : ""}`,
              )
              .join("\n"),
          () => checks.map((c) => [c.status.toUpperCase(), c.name, c.message].join("\t")),
        );
      }),
    );
}
