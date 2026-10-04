import { CommanderError } from "commander";

/**
 * Hook fast path: `event ingest --provider claude --source hook` must stay quick and print nothing but a
 * doorbell decision, so it is dispatched before the full CLI loads. Returns the pinned store flags when argv matches.
 */
function hookArgs(argv: string[]): { stateDir?: string; config?: string } | null {
  const args = argv.slice(2);
  const ingest = args.indexOf("ingest");
  if (ingest < 1 || args[ingest - 1] !== "event") return null;
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (value("--provider") !== "claude" || value("--source") !== "hook") return null;
  const out: { stateDir?: string; config?: string } = {};
  const stateDir = value("--state-dir");
  const config = value("--config");
  if (stateDir) out.stateDir = stateDir;
  if (config) out.config = config;
  return out;
}

export async function main(argv: string[]): Promise<void> {
  process.umask(0o077);
  const hook = hookArgs(argv);
  if (hook) {
    const { runHook } = await import("./adapters/claude/hook.ts");
    await runHook(hook);
    process.exitCode = 0;
    return;
  }

  const [{ buildProgram }, { emitError }, { EXIT, toAgentbusError, usageError }] = await Promise.all([
    import("./cli/program.ts"),
    import("./cli/context.ts"),
    import("./errors.ts"),
  ]);
  const json = argv.includes("--json");
  const mode = json ? "json" : argv.includes("--plain") ? "plain" : "human";
  const program = buildProgram({ quietErrors: json });
  const { runInterruptCleanups } = await import("./cli/interrupt.ts");
  const interrupted = () => {
    runInterruptCleanups();
    process.exit(EXIT.interrupted);
  };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  // Exit codes are set rather than forced so piped stdout fully drains before the process ends.
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        process.exitCode = 0;
        return;
      }
      if (json) emitError(mode, usageError(err.message.replace(/^error: /, "")));
      process.exitCode = EXIT.usage;
      return;
    }
    const e = toAgentbusError(err);
    emitError(mode, e);
    if (process.env.AGENTBUS_DEBUG && err instanceof Error) process.stderr.write(`${err.stack}\n`);
    process.exitCode = e.exitCode;
  }
}
