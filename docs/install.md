# Install, upgrade and configuration

[Back to README](../README.md)

## Requirements and locations

Requires Bun ≥ 1.4.2 (developed on `1.4.2+744846f84`; macOS system SQLite `3.43.2`, rollback journal).

State lives in `${XDG_STATE_HOME:-~/.local/state}/agentbus/` (internal disk, `0700`/`0600`); config in `${XDG_CONFIG_HOME:-~/.config}/agentbus/config.json`. Override with `--state-dir`/`--config` or `AGENTBUS_STATE_DIR`/`AGENTBUS_CONFIG`.

`upgrade` compiles a standalone executable to `${XDG_DATA_HOME:-~/.local/share}/agentbus/bin/agentbus` (~60 MB, includes the Bun runtime). Worker contracts and hooks run that copy whenever it exists. Background Claude sessions can be denied reads on external volumes by macOS privacy controls (observed: `stat` succeeds, `read` fails with `Operation not permitted`), so the CLI that workers execute must live on the internal disk. Rebuild after changing executable inputs; `agentbus doctor` compares source fingerprints and warns when the installed copy is stale, its identity cannot be verified, its recorded checkout is unavailable, or workers would run from an external volume. A compiled binary remains usable without its checkout. The shell's `agentbus` can be the npm-installed package (`bun add -g @vforsh/agentbus`), which runs its published sources and provides `agentbus upgrade`; a `bun link` into a checkout runs mutable development sources instead.

## Upgrades

After updating, run `agentbus upgrade` from the npm package (or `bun run upgrade` from a checkout) during an offline maintenance window (see below). The installed executable cannot upgrade itself. It verifies a compiled candidate, backs up an existing executable and mailbox, migrates the selected store and atomically replaces the executable. `install:bin` is an alias for this same workflow; it no longer overwrites the binary without verification. Schema v6 (wait evidence) leaves waits armed by an older build without process identity: they read as `unverified` until the parent re-arms with `wait --replace`.

### Local release and upgrade gate

```bash
bun run gate             # lint, typecheck, integration, e2e, compiled release checks
bun run release:check    # build + isolated compiled smoke only; installs nothing
bun run upgrade          # build, smoke-test, check selected store, back up, migrate, install
agentbus build-info --json
agentbus doctor --json
```

These are local commands; no CI configuration is required. The compiled smoke check drives the actual executable through keyed delegation, worker wrappers, Claude hook claim/doorbell/Stop, follow-up completion gating and migration with pending mail. No provider models are launched. The release tests also cover installation, older stores, preserved timestamps, unavailable checkouts, refusal paths, rollback after binary replacement and forward recovery after a killed upgrader. `upgrade` runs the compiled smoke; run the full `gate` before releasing code.

`build-info` reports package version, Git commit, dirty-checkout flag, SHA-256 source fingerprint, supported schema, build time and Bun version. The fingerprint covers `src/`, `scripts/`, `package.json`, `bun.lock` and `tsconfig.json`, including untracked source files. `--version` keeps its existing semver-only output. Standalone diagnostics use embedded identity; there is no sidecar or mtime freshness heuristic. A missing checkout is unverified, never reported as current. Legacy executables without build identity get a diagnostic warning.

**Upgrade offline.** Stop Agentbus users, workers and watchers, including users of other stores sharing this executable. The command checks only the selected store; it refuses open delegations, live or unverifiable unended waits, pending spool events, a newer schema, a non-DELETE journal, or database contention. A closed delegation alone does not prove its process has stopped. Resolve unknown/legacy wait evidence before upgrading; do not close real work just to bypass the gate. It does not stop processes, close delegations, acknowledge mail or drain events for you.

Store selection follows the CLI's flags/environment/config precedence:

```bash
agentbus upgrade --state-dir /absolute/state --config /absolute/config.json
```

`XDG_DATA_HOME` selects the installation root. Other stores sharing that executable are not discovered or migrated automatically; migrate them offline with the installed `agentbus init` before use, or use separate installation roots. The default remains the internal-disk path shown above.

The candidate is staged on the installation filesystem and verified before installation. Under an exclusive SQLite transaction, the upgrader saves a consistent private mailbox snapshot under `<state-dir>/backups/`, saves the old executable as `agentbus.before-<timestamp>-<uuid>`, applies/checks migrations, atomically renames the executable, then commits the schema. Ordinary failures roll back the transaction and restore the old executable; backup paths are returned on success. Backups are retained for manual review/removal and are outside `prune`.

SQLite and executable replacement cannot share one crash-atomic commit. A killed upgrader leaves `<installed-binary>.upgrade-lock/journal.json` with its stage, owner, build and backup paths; a later upgrade refuses that lock. Stop all Agentbus users, inspect the journal, installed `build-info` and store schema, verify the recorded upgrader is no longer running, remove only that upgrade-lock directory, then rerun `bun run upgrade`. Rerunning can finish a rolled-back migration with the verified candidate. Never blindly restore an old mailbox over messages written since the snapshot. This is an offline upgrade workflow, not a zero-downtime rolling upgrade.

The first verified local baseline is the annotated tag `v0.1.0`. Reproduce it from a clean checkout of that tag with `bun install --frozen-lockfile`, `bun run gate` and `bun run release:check`. Check that the resulting build has the tag's commit, `dirty: false`, package version `0.1.0` and schema v6; retain its source fingerprint and exact Bun version. Build timestamps and checkout paths vary, so this verifies the release inputs and behavior rather than byte-identical executable output. A verified candidate can be retained without replacing the installed binary while other work is active.

## Pruning history

Finished history stays until pruned: `agentbus prune --dry-run` lists workers created by `delegate` whose delegations ended, and whose mail, observations and waits went quiet, more than 7 days ago (`--older-than`); `agentbus prune` deletes them with their history. Registered sessions (parents) are never pruned, and a parent's unacknowledged mail keeps its worker. Worker settings files are kept so a resumed background owner can still start.

## Claude hooks

Hooks run only in Agentbus's own Claude workers; `~/.claude/settings.json` is not touched. `agentbus delegate --to claude` writes a private settings file and returns its path as `claudeSettings`; the launcher starts the worker with it:

```bash
claude --bg --settings "$claudeSettings" ...
```

The file subscribes `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `Stop`, `StopFailure` and `SessionEnd`, and pre-allows exactly the Agentbus CLI command (`permissions.allow`), so contract commands never stop on a permission prompt while other tools keep the session's permission mode. Each entry pins the absolute Bun runtime, CLI path, store and config, guarded so an unmounted checkout volume is a silent no-op. Hooks always exit 0 and print nothing except the follow-up doorbell.

**Doorbell.** When the parent of a worker's open delegation has sent it mail the worker has not seen, the next `PostToolUse` announces it as `additionalContext`, and a `Stop` is blocked (`decision: block`) until the worker has been shown it. The announcement carries message IDs, summaries and the exact `read`/`ack` commands; claiming marks the mail seen, so each message rings once. A blocked Stop is not recorded as a turn end. `PostToolUse` costs one read-only lookup per tool call. `agentbus hooks claude print [--settings-file <path>]` shows or writes the same settings.

Observation scope is the background owner, as with the Codex runner: after a Desktop handoff the resumed session does not carry `--settings`, so lifecycle notices stop and the worker's explicit `question`/`result` replies plus `--probe` remain. An optional user-level install (`agentbus hooks claude install|uninstall|status [--dry-run]`) extends capture across the handoff at the cost of running the hook, one ~31 ms read-only lookup, in every Claude session; it preserves unrelated entries and writes a private backup.

## Config keys

| Key | Default | Purpose |
| --- | --- | --- |
| `stateDir` | XDG state dir | Store location (flags and env win) |
| `claudeBin` / `codexBin` | `claude` / `codex` on PATH | Provider executables used by probes |
| `claudeSettingsPath` | `~/.claude/settings.json` | Target of `hooks claude` |
| `claudeJobsDir` | `~/.claude/jobs` | Optional job diagnostics for `--probe` |
| `cliCommand` | installed executable, else `<bun> <checkout>/src/main.ts` | Command rendered into worker contracts and hooks |

```bash
agentbus config set codexBin=/opt/homebrew/bin/codex
```
