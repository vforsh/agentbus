import { readFileSync, statSync } from "node:fs";
import { Command } from "commander";
import {
  bind,
  captureView,
  cleanup,
  created,
  exclusive,
  finishWorker,
  load,
  prepare,
  status,
  tick,
} from "./heartbeat-restart/experiment.ts";

const program = new Command("heartbeat-restart").description(
  "Opt-in isolated Codex heartbeat restart experiment; never restarts an app or launches a model",
);
const print = (data: unknown): void => {
  process.stdout.write(`${JSON.stringify(data)}\n`);
};
const receipt = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

program
  .command("prepare")
  .requiredOption("--dir <path>")
  .requiredOption("--thread <uuid>")
  .option("--fixture", "process-only evidence; never a live acceptance pass")
  .action((o) => {
    const m = prepare(o.dir, o.fixture ? "fixture" : "live", o.thread);
    print({
      dir: m.dir,
      id: m.id,
      threadId: m.threadId,
      mode: m.mode,
      prompt: `${m.dir}/heartbeat-prompt.txt`,
    });
  });
for (const cmd of ["created", "capture-view", "bind", "tick", "cleanup"] as const) {
  program
    .command(cmd)
    .requiredOption("--dir <path>")
    .requiredOption("--receipt <path>")
    .option("--interrupt-after-handle", "fixture fault: stop before ack to test retry deduplication")
    .option("--abort", "cleanup a cancelled disposable experiment; never passes acceptance")
    .option("--fixture-config <path>", "capture-view only: isolated configuration fixture")
    .action((o) =>
      exclusive(o.dir, () => {
        const m = load(o.dir);
        if (
          m.mode === "live" &&
          ["bind", "tick", "capture-view"].includes(cmd) &&
          Date.now() - statSync(o.receipt).mtimeMs > 60_000
        )
          throw new Error("Save a fresh supported automation receipt before checking in");
        if (o.interruptAfterHandle && m.mode !== "fixture")
          throw new Error("Fault injection is fixture-only");
        const r = receipt(o.receipt);
        if (cmd === "created") created(m, r);
        else if (cmd === "capture-view")
          return print({
            evidence: captureView(m, r, o.fixtureConfig),
            source: "supported_view_and_read_only_config",
            limitation: "Rendered app card plus persisted config; scheduling still unverified",
          });
        else if (cmd === "bind") bind(m, r);
        else if (cmd === "cleanup") cleanup(m, r, !!o.abort);
        else return print(tick(m, r, !!o.interruptAfterHandle));
        print({ command: cmd, cleanup: m.cleanup, automationId: m.automationId });
      }),
    );
}
program
  .command("finish-worker")
  .requiredOption("--dir <path>")
  .action((o) =>
    exclusive(o.dir, () => {
      finishWorker(load(o.dir));
      print({ guardFinished: true });
    }),
  );
program
  .command("status")
  .requiredOption("--dir <path>")
  .action((o) => print(status(load(o.dir))));

try {
  await program.parseAsync();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
