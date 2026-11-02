import { Command, Option } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { registerConfig } from "./commands/config.ts";
import { registerDelegate } from "./commands/delegate.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerEvent } from "./commands/event.ts";
import { registerExplain } from "./commands/explain.ts";
import { registerHooks } from "./commands/hooks.ts";
import { registerMessaging } from "./commands/messaging.ts";
import { registerBuildInfo, registerCompletion, registerSkill } from "./commands/meta.ts";
import { registerMetrics } from "./commands/metrics.ts";
import { registerPrune } from "./commands/prune.ts";
import { registerInit, registerSessionCommands, registerWhoami } from "./commands/session.ts";
import { registerStatus } from "./commands/status.ts";
import { registerTake } from "./commands/take.ts";

export const VERSION = pkg.version;

/** Settings applied before registration so every subcommand inherits exit and output behavior. */
export function buildProgram(opts: { quietErrors?: boolean } = {}): Command {
  const program = new Command("agentbus")
    .description("Durable local mailbox and delegation bus between Codex and Claude Code sessions")
    .version(VERSION, "--version", "print the version")
    .helpOption("-h, --help", "show help")
    .option("--as <address>", "act as this session (internal UUID or provider:<native-id>)")
    .option("--config <path>", "config file (default: $XDG_CONFIG_HOME/agentbus/config.json)")
    .option("--state-dir <dir>", "state directory (default: $XDG_STATE_HOME/agentbus)")
    .option("--json", "one versioned JSON object on stdout, including failures")
    .option("--plain", "stable tab-separated output")
    .option("-q, --quiet", "suppress human output (never machine receipts)")
    .option("-v, --verbose", "diagnostics on stderr")
    .option("--no-color", "disable color")
    .addOption(new Option("--no-input", "never prompt (agentbus never prompts; accepted for scripting)"))
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeErr: (str) => {
        if (!opts.quietErrors) process.stderr.write(str);
      },
    });

  registerInit(program);
  registerWhoami(program);
  registerSessionCommands(program);
  registerDelegate(program);
  registerMessaging(program);
  registerTake(program);
  registerStatus(program);
  registerMetrics(program);
  registerExplain(program);
  registerPrune(program);
  registerEvent(program);
  registerHooks(program);
  registerConfig(program);
  registerDoctor(program);
  registerBuildInfo(program);
  registerSkill(program);
  registerCompletion(program);
  hintForeignOptions(program);
  return program;
}

function walk(cmd: Command): Command[] {
  return [cmd, ...cmd.commands.flatMap(walk)];
}

const path = (cmd: Command): string => (cmd.parent ? `${path(cmd.parent)} ${cmd.name()}` : cmd.name());

/**
 * An unknown option that another command accepts (`read --timeout`) names that command, since agents often
 * carry flags over from a neighbouring command. Commander's own near-miss suggestion still applies otherwise.
 */
function hintForeignOptions(program: Command): void {
  const all = walk(program);
  for (const cmd of all) {
    const own = cmd as unknown as { unknownOption(flag: string): void };
    const original = own.unknownOption.bind(cmd);
    own.unknownOption = (flag: string) => {
      const long = flag.split("=")[0]!;
      const owners = all.filter((c) => c !== cmd && c.parent && c.options.some((o) => o.long === long));
      if (owners.length === 0 || (cmd as unknown as { _allowUnknownOption: boolean })._allowUnknownOption)
        return original(flag);
      const names = owners.map((c) => `\`${path(c)}\``).join(", ");
      cmd.error(`error: unknown option '${flag}' for \`${path(cmd)}\`; it is an option of ${names}`, {
        code: "commander.unknownOption",
      });
    };
  }
}
