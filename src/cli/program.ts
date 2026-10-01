import { Command, Option } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { registerConfig } from "./commands/config.ts";
import { registerDelegate } from "./commands/delegate.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerEvent } from "./commands/event.ts";
import { registerHooks } from "./commands/hooks.ts";
import { registerMessaging } from "./commands/messaging.ts";
import { registerCompletion, registerSkill } from "./commands/meta.ts";
import { registerInit, registerSessionCommands, registerWhoami } from "./commands/session.ts";
import { registerStatus } from "./commands/status.ts";

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
  registerStatus(program);
  registerEvent(program);
  registerHooks(program);
  registerConfig(program);
  registerDoctor(program);
  registerSkill(program);
  registerCompletion(program);
  return program;
}
