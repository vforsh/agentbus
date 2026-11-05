import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { AgentbusError, EXIT, usageError } from "../errors.ts";
import { fileExists, writeFileAtomic } from "../util/fsx.ts";

/** Every accepted key; unknown keys are rejected rather than silently ignored. */
export const ConfigSchema = z
  .object({
    stateDir: z.string().min(1).optional(),
    claudeBin: z.string().min(1).optional(),
    codexBin: z.string().min(1).optional(),
    claudeSettingsPath: z.string().min(1).optional(),
    claudeJobsDir: z.string().min(1).optional(),
    cliCommand: z.string().min(1).optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigKey = keyof Config;
export const CONFIG_KEYS = Object.keys(ConfigSchema.shape) as ConfigKey[];

export interface PathOverrides {
  config?: string | undefined;
  stateDir?: string | undefined;
}

export interface Resolved {
  configPath: string;
  configSource: "flag" | "env" | "default";
  config: Config;
  stateDir: string;
  stateDirSource: "flag" | "env" | "config" | "default";
  dbPath: string;
  spoolDir: string;
  logsDir: string;
  claudeBin: string;
  codexBin: string;
  claudeSettingsPath: string;
  claudeJobsDir: string;
  /** Shell-ready command that runs this CLI; used in worker contracts and hook entries. */
  cliCommand: string;
  /** The same command as an argument vector, or null when `cliCommand` comes from config verbatim. */
  cliArgv: string[] | null;
}

const expandHome = (p: string): string => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const absolute = (p: string): string => {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(e);
};

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME
    ? absolute(process.env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  return join(base, "agentbus", "config.json");
}

export function defaultStateDir(): string {
  const base = process.env.XDG_STATE_HOME
    ? absolute(process.env.XDG_STATE_HOME)
    : join(homedir(), ".local", "state");
  return join(base, "agentbus");
}

export function readConfigFile(path: string): Config {
  if (!fileExists(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new AgentbusError(
      "config_invalid",
      `Config ${path} is not valid JSON: ${(err as Error).message}`,
      EXIT.failure,
      {
        path,
      },
    );
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentbusError(
      "config_invalid",
      `Config ${path} is invalid: ${z.prettifyError(parsed.error)}`,
      EXIT.failure,
      {
        path,
      },
    );
  }
  return parsed.data;
}

export function writeConfigFile(path: string, config: Config): void {
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) throw usageError(`Invalid config value: ${z.prettifyError(parsed.error)}`, { path });
  writeFileAtomic(path, JSON.stringify(parsed.data, null, 2) + "\n");
}

export const shellQuote = (s: string): string =>
  /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** Running as the standalone executable built by `bun run install:bin`. */
const COMPILED = import.meta.dir.startsWith("/$bunfs") || import.meta.dir.includes("~BUN");

/** `.ts` source entry: if a worker cannot read the checkout, Bun fails instead of re-running a shebang. */
export const SOURCE_ENTRY = resolve(import.meta.dir, "../main.ts");

export function installedBinPath(): string {
  const base = process.env.XDG_DATA_HOME
    ? absolute(process.env.XDG_DATA_HOME)
    : join(homedir(), ".local", "share");
  return join(base, "agentbus", "bin", "agentbus");
}

/**
 * What workers and hooks execute: this standalone executable, the installed one on the internal disk,
 * or Bun plus the source entry. Background Claude sessions may be denied reads on external volumes,
 * so the installed executable is preferred whenever it exists.
 */
function defaultCliArgv(): string[] {
  if (COMPILED) return [process.execPath];
  const installed = installedBinPath();
  if (fileExists(installed)) return [installed];
  return [process.execPath, SOURCE_ENTRY];
}

/** Precedence: explicit flags, AGENTBUS_* environment, user config, defaults. */
export function resolvePaths(overrides: PathOverrides): Resolved {
  let configPath: string;
  let configSource: Resolved["configSource"];
  if (overrides.config) {
    configPath = absolute(overrides.config);
    configSource = "flag";
  } else if (process.env.AGENTBUS_CONFIG) {
    configPath = absolute(process.env.AGENTBUS_CONFIG);
    configSource = "env";
  } else {
    configPath = defaultConfigPath();
    configSource = "default";
  }
  const config = readConfigFile(configPath);

  let stateDir: string;
  let stateDirSource: Resolved["stateDirSource"];
  if (overrides.stateDir) {
    stateDir = absolute(overrides.stateDir);
    stateDirSource = "flag";
  } else if (process.env.AGENTBUS_STATE_DIR) {
    stateDir = absolute(process.env.AGENTBUS_STATE_DIR);
    stateDirSource = "env";
  } else if (config.stateDir) {
    stateDir = absolute(config.stateDir);
    stateDirSource = "config";
  } else {
    stateDir = defaultStateDir();
    stateDirSource = "default";
  }

  return {
    configPath,
    configSource,
    config,
    stateDir,
    stateDirSource,
    dbPath: join(stateDir, "agentbus.sqlite3"),
    spoolDir: join(stateDir, "spool"),
    logsDir: join(stateDir, "logs"),
    claudeBin: config.claudeBin ? expandHome(config.claudeBin) : "claude",
    codexBin: config.codexBin ? expandHome(config.codexBin) : "codex",
    claudeSettingsPath: config.claudeSettingsPath
      ? absolute(config.claudeSettingsPath)
      : join(homedir(), ".claude", "settings.json"),
    claudeJobsDir: config.claudeJobsDir ? absolute(config.claudeJobsDir) : join(homedir(), ".claude", "jobs"),
    ...cliOf(config),
  };
}

function cliOf(config: Config): { cliCommand: string; cliArgv: string[] | null } {
  if (config.cliCommand) return { cliCommand: config.cliCommand, cliArgv: null };
  const argv = defaultCliArgv();
  return { cliCommand: argv.map(shellQuote).join(" "), cliArgv: argv };
}

/** Parses `key=value` or validates a bare key against the schema. */
export function assertConfigKey(key: string): ConfigKey {
  if (!(CONFIG_KEYS as string[]).includes(key)) {
    throw usageError(`Unknown config key: ${key}. Known keys: ${CONFIG_KEYS.join(", ")}`, { key });
  }
  return key as ConfigKey;
}
