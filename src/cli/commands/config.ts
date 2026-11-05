import type { Command } from "commander";
import { z } from "zod";
import {
  assertConfigKey,
  CONFIG_KEYS,
  type Config,
  ConfigSchema,
  readConfigFile,
  writeConfigFile,
} from "../../config/config.ts";
import { inputError, usageError } from "../../errors.ts";
import { action } from "../action.ts";
import { readBody } from "../context.ts";

export function registerConfig(program: Command): void {
  const cfg = program.command("config").alias("cfg").description("Manage the user config file");

  const effective = (
    c: Config,
    ctx: {
      paths: {
        stateDir: string;
        claudeBin: string;
        codexBin: string;
        claudeSettingsPath: string;
        claudeJobsDir: string;
        cliCommand: string;
        pruneOlderThan: string;
      };
    },
  ) => ({
    stateDir: ctx.paths.stateDir,
    claudeBin: ctx.paths.claudeBin,
    codexBin: ctx.paths.codexBin,
    claudeSettingsPath: ctx.paths.claudeSettingsPath,
    claudeJobsDir: ctx.paths.claudeJobsDir,
    cliCommand: ctx.paths.cliCommand,
    pruneOlderThan: ctx.paths.pruneOlderThan,
    configured: c,
  });

  cfg
    .command("list")
    .alias("ls")
    .description("List configured values and effective settings")
    .action(
      action((ctx) => {
        const data = { configPath: ctx.paths.configPath, ...effective(ctx.paths.config, ctx) };
        ctx.emit(
          data,
          () =>
            CONFIG_KEYS.map(
              (k) => `${k.padEnd(20)} ${data[k]}${ctx.paths.config[k] !== undefined ? "" : " (default)"}`,
            ).join("\n"),
          () => CONFIG_KEYS.map((k) => `${k}\t${data[k]}`),
        );
      }),
    );

  cfg
    .command("path")
    .description("Print the resolved config and state paths")
    .action(
      action((ctx) => {
        const p = ctx.paths;
        const data = {
          configPath: p.configPath,
          configSource: p.configSource,
          stateDir: p.stateDir,
          stateDirSource: p.stateDirSource,
          dbPath: p.dbPath,
        };
        ctx.emit(
          data,
          () =>
            `config ${p.configPath} (${p.configSource})\nstate  ${p.stateDir} (${p.stateDirSource})\ndb     ${p.dbPath}`,
          () => [p.configPath, p.stateDir, p.dbPath],
        );
      }),
    );

  cfg
    .command("get <keys...>")
    .description("Get one or more effective values")
    .action(
      action((ctx, keys: string[]) => {
        const eff = effective(ctx.paths.config, ctx) as Record<string, unknown>;
        const data = Object.fromEntries(keys.map((k) => [assertConfigKey(k), eff[k]]));
        ctx.emit(
          data,
          () => keys.map((k) => `${k}=${data[k]}`).join("\n"),
          () => keys.map((k) => String(data[k])),
        );
      }),
    );

  cfg
    .command("set <assignments...>")
    .description("Set values: key=value pairs, `key value`, or `key -` to read the value from stdin")
    .action(
      action(async (ctx, args: string[]) => {
        const updates: Record<string, string> = {};
        if (args.length === 2 && !args[0]!.includes("=")) {
          const key = assertConfigKey(args[0]!);
          updates[key] = args[1] === "-" ? (await readBody("-", 64 * 1024, "config value")).trim() : args[1]!;
        } else {
          for (const a of args) {
            const idx = a.indexOf("=");
            if (idx <= 0) throw usageError(`Expected key=value, got "${a}"`);
            updates[assertConfigKey(a.slice(0, idx))] = a.slice(idx + 1);
          }
        }
        const next = { ...readConfigFile(ctx.paths.configPath), ...updates };
        writeConfigFile(ctx.paths.configPath, next);
        ctx.emit(
          { configPath: ctx.paths.configPath, updated: Object.keys(updates) },
          () => `Updated ${Object.keys(updates).join(", ")}`,
        );
      }),
    );

  cfg
    .command("unset <keys...>")
    .description("Remove one or more keys")
    .action(
      action((ctx, keys: string[]) => {
        const next: Record<string, unknown> = { ...readConfigFile(ctx.paths.configPath) };
        for (const k of keys) delete next[assertConfigKey(k)];
        writeConfigFile(ctx.paths.configPath, next as Config);
        ctx.emit({ configPath: ctx.paths.configPath, removed: keys }, () => `Removed ${keys.join(", ")}`);
      }),
    );

  cfg
    .command("import")
    .description("Replace the config with a JSON object read from stdin (idempotent machine setup)")
    .action(
      action(async (ctx) => {
        const text = await readBody("-", 64 * 1024, "config JSON");
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch (err) {
          throw inputError("invalid_json", `Config JSON is invalid: ${(err as Error).message}`);
        }
        const parsed = ConfigSchema.safeParse(raw);
        if (!parsed.success) throw inputError("config_invalid", z.prettifyError(parsed.error));
        writeConfigFile(ctx.paths.configPath, parsed.data);
        ctx.emit(
          { configPath: ctx.paths.configPath, config: parsed.data },
          () => `Imported config into ${ctx.paths.configPath}`,
        );
      }),
    );

  cfg
    .command("export")
    .description("Print the configured values as JSON")
    .action(
      action((ctx) => {
        ctx.emit(ctx.paths.config, () => JSON.stringify(ctx.paths.config, null, 2));
      }),
    );
}
