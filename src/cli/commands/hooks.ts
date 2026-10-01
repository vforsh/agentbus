import type { Command } from "commander";
import pc from "picocolors";
import {
  applySettings,
  HOOK_EVENTS,
  hookStatus,
  hooksSettings,
  loadSettings,
  planInstall,
  planUninstall,
  writeHooksSettings,
} from "../../adapters/claude/settings.ts";
import { action } from "../action.ts";

export function registerHooks(program: Command): void {
  const hooks = program.command("hooks").description("Provider hook management");
  const claude = hooks
    .command("claude")
    .description("Claude Code hooks: per-worker settings files (default) or an optional user-level install");

  claude
    .command("print")
    .description("Print the hook settings with this store's pinned paths, or write them to a file")
    .option("--settings-file <path>", "write a standalone settings file for `claude --settings <path>`")
    .action(
      action((ctx, opts: { settingsFile?: string }) => {
        const settings = hooksSettings(ctx.paths);
        if (opts.settingsFile) {
          writeHooksSettings(opts.settingsFile, ctx.paths);
          ctx.emit(
            { settingsFile: opts.settingsFile },
            () => `Wrote Agentbus hook settings to ${opts.settingsFile}`,
          );
          return;
        }
        ctx.emit(settings, () => JSON.stringify(settings, null, 2));
      }),
    );

  claude
    .command("install")
    .description("Optional: merge Agentbus hooks into Claude user settings, affecting every session")
    .option("--dry-run", "describe the change without writing")
    .action(
      action((ctx, opts: { dryRun?: boolean }) => {
        const path = ctx.paths.claudeSettingsPath;
        const before = loadSettings(path);
        const plan = planInstall(before.json, ctx.paths);
        if (opts.dryRun || !plan.changed) {
          ctx.emit(
            { settingsPath: path, changed: plan.changed, dryRun: !!opts.dryRun, events: HOOK_EVENTS },
            () =>
              plan.changed
                ? `Would install Agentbus hooks for ${HOOK_EVENTS.join(", ")} into ${path}`
                : `Agentbus hooks already current in ${path}`,
          );
          return;
        }
        const { backupPath } = applySettings(path, before, plan.json);
        ctx.emit(
          { settingsPath: path, changed: true, backupPath, events: HOOK_EVENTS },
          () => `Installed Agentbus hooks into ${path}${backupPath ? pc.dim(` (backup ${backupPath})`) : ""}`,
        );
      }),
    );

  claude
    .command("uninstall")
    .description("Remove only Agentbus-owned hook entries")
    .option("--dry-run", "describe the change without writing")
    .action(
      action((ctx, opts: { dryRun?: boolean }) => {
        const path = ctx.paths.claudeSettingsPath;
        const before = loadSettings(path);
        const plan = planUninstall(before.json);
        if (opts.dryRun || !plan.changed) {
          ctx.emit(
            { settingsPath: path, changed: plan.changed, removed: plan.removed, dryRun: !!opts.dryRun },
            () =>
              plan.changed
                ? `Would remove ${plan.removed} Agentbus hook entr(ies) from ${path}`
                : `No Agentbus hooks in ${path}`,
          );
          return;
        }
        const { backupPath } = applySettings(path, before, plan.json);
        ctx.emit(
          { settingsPath: path, changed: true, removed: plan.removed, backupPath },
          () => `Removed ${plan.removed} Agentbus hook entr(ies) from ${path}`,
        );
      }),
    );

  claude
    .command("status")
    .description("Verify hook installation without writing")
    .action(
      action((ctx) => {
        const s = hookStatus(ctx.paths);
        if (!s.current) ctx.exitCode = 1;
        ctx.emit(
          s,
          () =>
            [
              `${s.current ? pc.green("OK") : s.installed ? pc.yellow("STALE") : pc.red("MISSING")} ${s.settingsPath}`,
              ...Object.entries(s.events).map(
                ([e, v]) =>
                  `  ${e.padEnd(18)} ${v.entries} entr${v.entries === 1 ? "y" : "ies"}${v.current ? "" : pc.yellow(" (not current)")}`,
              ),
            ].join("\n"),
          () => Object.entries(s.events).map(([e, v]) => [e, v.entries, v.current].join("\t")),
        );
      }),
    );
}
