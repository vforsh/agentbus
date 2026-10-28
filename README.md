# agentbus

Durable local mailbox and delegation bus between Codex and Claude Code sessions. A parent delegates a task to a worker session; progress, questions, results and observed lifecycle notices come back to the parent's inbox. Messages are committed to SQLite before any receipt is printed and stay recoverable until acknowledged.

Design and rationale: [PLAN.md](PLAN.md). Agent-facing usage: [skill/agentbus/SKILL.md](skill/agentbus/SKILL.md).

## Status

| Milestone | State |
| --- | --- |
| 1. Scaffold, contracts, config, diagnostics | Implemented |
| 2. Durable mailbox (sessions, messages, receipts, delegations, waits) | Implemented; acceptance 1–4 covered by process-level checks |
| 3. Worker result capture (Claude hooks + spool, Codex runner events, probes, phases) | Implemented at the adapter level with recorded fixtures; live Claude checks below still open |
| 4. Launcher integration and live Codex↔Claude workflows | Launchers tracked by default; Claude→Codex and Codex→Claude live gates passed |
| 5. `claude-threads` on Agentbus | Implemented; live gate passed (acceptance 13–14) |
| 6. Codex wake adapter | [Capability spike](docs/spikes/codex-wake-2026-10-06.md) failed at backend reachability (2026-10-06); heartbeat retained, adapter deferred |

Live gates that passed are listed under [Live checks](#live-checks); everything else is proven by fixture-driven checks for recorded payload shapes, not live delivery.

## Install

Requires Bun ≥ 1.4.2 (developed on `1.4.2+744846f84`; macOS system SQLite `3.43.2`, rollback journal).

```bash
cd ~/dev/agentbus && bun install && bun link
```

```bash
bun run upgrade
```

```bash
agentbus init
```

```bash
agentbus doctor
```

Finished history stays until pruned: `agentbus prune --dry-run` lists workers created by `delegate` whose delegations ended, and whose mail, observations and waits went quiet, more than 7 days ago (`--older-than`); `agentbus prune` deletes them with their history. Registered sessions (parents) are never pruned, and a parent's unacknowledged mail keeps its worker. Worker settings files are kept so a resumed background owner can still start.

After pulling changes, run `bun run upgrade` from the checkout during an offline maintenance window (see below). It verifies a compiled candidate, backs up an existing executable and mailbox, migrates the selected store and atomically replaces the executable. `install:bin` is an alias for this same workflow; it no longer overwrites the binary without verification. Schema v6 (wait evidence) leaves waits armed by an older build without process identity: they read as `unverified` until the parent re-arms with `wait --replace`.

`upgrade` compiles a standalone executable to `${XDG_DATA_HOME:-~/.local/share}/agentbus/bin/agentbus` (~60 MB, includes the Bun runtime). Worker contracts and hooks run that copy whenever it exists. Background Claude sessions can be denied reads on external volumes by macOS privacy controls (observed: `stat` succeeds, `read` fails with `Operation not permitted`), so the CLI that workers execute must live on the internal disk. Rebuild after changing executable inputs; `agentbus doctor` compares source fingerprints and warns when the installed copy is stale, its identity cannot be verified, its recorded checkout is unavailable, or workers would run from an external volume. A compiled binary remains usable without its checkout. Point the shell's `agentbus` command at that installed executable too; a legacy `bun link` into the checkout runs mutable development sources instead.

State lives in `${XDG_STATE_HOME:-~/.local/state}/agentbus/` (internal disk, `0700`/`0600`); config in `${XDG_CONFIG_HOME:-~/.config}/agentbus/config.json`. Override with `--state-dir`/`--config` or `AGENTBUS_STATE_DIR`/`AGENTBUS_CONFIG`.

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
bun run upgrade --state-dir /absolute/state --config /absolute/config.json
```

`XDG_DATA_HOME` selects the installation root. Other stores sharing that executable are not discovered or migrated automatically; migrate them offline with the installed `agentbus init` before use, or use separate installation roots. The default remains the internal-disk path shown above.

The candidate is staged on the installation filesystem and verified before installation. Under an exclusive SQLite transaction, the upgrader saves a consistent private mailbox snapshot under `<state-dir>/backups/`, saves the old executable as `agentbus.before-<timestamp>-<uuid>`, applies/checks migrations, atomically renames the executable, then commits the schema. Ordinary failures roll back the transaction and restore the old executable; backup paths are returned on success. Backups are retained for manual review/removal and are outside `prune`.

SQLite and executable replacement cannot share one crash-atomic commit. A killed upgrader leaves `<installed-binary>.upgrade-lock/journal.json` with its stage, owner, build and backup paths; a later upgrade refuses that lock. Stop all Agentbus users, inspect the journal, installed `build-info` and store schema, verify the recorded upgrader is no longer running, remove only that upgrade-lock directory, then rerun `bun run upgrade`. Rerunning can finish a rolled-back migration with the verified candidate. Never blindly restore an old mailbox over messages written since the snapshot. This is an offline upgrade workflow, not a zero-downtime rolling upgrade.

The first verified local baseline is the annotated tag `v0.1.0`. Reproduce it from a clean checkout of that tag with `bun install --frozen-lockfile`, `bun run gate` and `bun run release:check`. Check that the resulting build has the tag's commit, `dirty: false`, package version `0.1.0` and schema v6; retain its source fingerprint and exact Bun version. Build timestamps and checkout paths vary, so this verifies the release inputs and behavior rather than byte-identical executable output. A verified candidate can be retained without replacing the installed binary while other work is active.

### Claude hooks

Hooks run only in Agentbus's own Claude workers; `~/.claude/settings.json` is not touched. `agentbus delegate --to claude` writes a private settings file and returns its path as `claudeSettings`; the launcher starts the worker with it:

```bash
claude --bg --settings "$claudeSettings" ...
```

The file subscribes `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `Stop`, `StopFailure` and `SessionEnd`, and pre-allows exactly the Agentbus CLI command (`permissions.allow`), so contract commands never stop on a permission prompt while other tools keep the session's permission mode. Each entry pins the absolute Bun runtime, CLI path, store and config, guarded so an unmounted checkout volume is a silent no-op. Hooks always exit 0 and print nothing except the follow-up doorbell.

**Doorbell.** When the parent of a worker's open delegation has sent it mail the worker has not seen, the next `PostToolUse` announces it as `additionalContext`, and a `Stop` is blocked (`decision: block`) until the worker has been shown it. The announcement carries message IDs, summaries and the exact `read`/`ack` commands; claiming marks the mail seen, so each message rings once. A blocked Stop is not recorded as a turn end. `PostToolUse` costs one read-only lookup per tool call. `agentbus hooks claude print [--settings-file <path>]` shows or writes the same settings.

Observation scope is the background owner, as with the Codex runner: after a Desktop handoff the resumed session does not carry `--settings`, so lifecycle notices stop and the worker's explicit `question`/`result` replies plus `--probe` remain. An optional user-level install (`agentbus hooks claude install|uninstall|status [--dry-run]`) extends capture across the handoff at the cost of running the hook, one ~31 ms read-only lookup, in every Claude session; it preserves unrelated entries and writes a private backup.

### Config keys

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

## Quick start

```bash
# Parent (Claude Desktop session; identity from CLAUDE_CODE_SESSION_ID)
agentbus session register --provider claude --external-id "$CLAUDE_CODE_SESSION_ID" --name lead
agentbus delegate --to codex --name executor --cwd ~/dev/project --key task-002 --file request.md --json
agentbus wait --replace --timeout 30m --probe 60s --json   # as a background command

# Worker (follows the generated <agentbus-contract> block; <worker-bin> fixes store and --as)
<worker-bin> read --correlation <request-id>
<worker-bin> ack <request-id>
<worker-bin> reply <request-id> --type result --outcome success --key result-1 \
  --summary "Parser fixed; tests pass" --file result.md

# Parent: new facts mid-task (refused with exit 5 once the delegation has ended)
agentbus followup executor --summary "Use the staging DB" --file followup.md

# Parent, re-invoked by its wait
agentbus read
agentbus ack <result-id>
agentbus delegations
agentbus explain executor     # timeline, why it is stuck, next steps; changes nothing
```

## Commands

```text
agentbus init | whoami | build-info | doctor|check | skill | completion <fish|zsh|bash>
agentbus session register|bind|list|show
agentbus session update <session> [--name] [--label k=v]... [--binding-file <path|->|--refresh]
agentbus delegate --to <claude|codex> --file <path|-> [--name] [--cwd] [--allow-missing-cwd] [--key] [--summary] [--label k=v]... [--contract-out] [--dry-run]
agentbus delegations [<request-id|name>...] [--all] [--global] [--probe]
agentbus send <recipient> --file <path|-> [--type message|request] [--key] [--summary] [--dry-run]
agentbus followup <request-id|name> --file <path|-> [--key] [--summary] [--dry-run]
agentbus reply <message-id> --file <path|-> [--type message|progress|question|result] [--outcome] [--key] [--summary] [--no-ack]
agentbus show <message-id>
agentbus read [--ack|--mark-seen] [--all] [--unseen] [--after <seq>] [--from] [--type] [--correlation] [--limit]
agentbus wait [--timeout 60s] [--settled] [--probe <interval>] [--replace] [--after] [--from] [--type] [--correlation] [--limit]
agentbus ack <message-id...> | close <request-id|name>
agentbus status [<session>] [--probe]
agentbus metrics [--global] [--since <date|duration>] [--until <date>] [--project <dir>] [--direction <parent:worker>] [--model <model>] [--label k=v]... [--group-by <field>]
agentbus explain <request-id|name> [--global] [--probe] [--limit 40]
agentbus event ingest --provider claude --source hook        # stdin, silent; used by hooks
agentbus event ingest --provider codex --source runner --file <event.json>
agentbus event drain
agentbus prune [--older-than 7d] [--dry-run]
agentbus hooks claude print|install|uninstall|status [--dry-run]
agentbus config|cfg list|ls|path|get|set|unset|import|export
```

Global: `--as`, `--config`, `--state-dir`, `--json`, `--plain`, `-q`, `-v`, `--no-color`, `--no-input`, `--version`, `-h`.

For agents and humans, `read` prints readable bodies; `show <id>` prints one full body, including acknowledged mail (sender or recipient only). Use `--json` for scripts. Replies acknowledge their source in the same transaction; `--no-ack` opts out. Failed replies and dry runs leave receipts unchanged. Keyed retries can acknowledge the source without sending another reply; opting out never reverses an existing acknowledgement or delegation settlement.

Batch `ack <id>…` after handling results. `read --ack` accepts only the returned, filtered page and preserves pagination. It commits acknowledgement before printing, so use it only when accepting that batch: a lost stdout does not undo acceptance; recover its bodies with `read --all` or `show`.

The companion `claude-threads` launcher provides `cleanup.sh cancel <name|request-id>` (stop the owner, close the delegation, keep the session). The `agentbus-threads` mod previews question/result bodies and supports opt-in `stop_when_settled`, which stops idle child owners after their result is acknowledged and background work has ended.

### Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Success (for `send`, the message is committed) |
| 1 | Unexpected failure; `doctor` not ready; `hooks claude status` not current |
| 2 | Invalid usage or input (bad flags, >1 MiB body, malformed UTF-8) |
| 3 | `wait` timed out: empty list, `timedOut: true`; run the recovery `read` anyway |
| 4 | Session, message, delegation or store not found |
| 5 | Conflict: retry key reuse, ambiguous identity, wrong role/recipient, closed delegation (including a late `followup` or answer), `success` with unacknowledged follow-ups (`followups_pending`), busy worker, binding conflict |
| 6 | Database busy past the deadline (5 s for commands, 1 s for hooks) |
| 130 | Interrupted |

`--json` prints exactly one `{"schemaVersion":1,"ok":...}` object per invocation, including failures.

## Protocol

- **Envelope v1**: `id`, `sequence`, `from`, `to`, `type` (`message|request|progress|question|result|notice`), `summary`, `body`, `createdAt`, `correlationId` (root request), `inReplyTo`, `idempotencyKey`, `outcome` (results only), `notice` (`{kind, observationId, provider, truncated?, originalBytes?}`), `turnRef`, `seenAt`, `acknowledgedAt`.
- **Roles**: `progress`/`question`/`result` go from a delegation's worker to its parent via `reply`; a parent answers with a `message` reply to the question ID. Notices come only from `system:observer` and cannot be replied to. One open delegation per worker, one unresolved question per delegation; every result is terminal.
- **Follow-ups**: `followup <request>` sends parent mail into an open delegation and is refused (exit 5, `delegation_closed`) once it has ended; a parent's plain `send` to the worker of its open delegation also joins it, but silently becomes an ordinary message afterwards. Answers to questions are follow-ups too, and parent replies into an ended delegation are refused. Claude workers get follow-ups through the doorbell mid-turn.
- **Completion gate**: a `success` result is refused (exit 5, `followups_pending`, listing the IDs) while any parent follow-up or answer of the delegation is unacknowledged by the worker; seen is not handled. The check and the close share one transaction with `followup`, so in either order a follow-up is handled or visibly refused. Refused attempts consume no retry key. `blocked`/`failed`/`unknown` results are accepted and report leftovers as `unhandledFollowUps` (also in `delegations`/`explain` as `followUps.unhandled`); the parent's `close` is never gated.
- **Settlement**: a delegation's terminal transition acknowledges mail nobody needs to handle any more, with `settledReason`: a result settles the worker's side (`delegation_done`), a parent's `close` the whole correlation (`delegation_closed`). The result itself stays with the parent.
- **Return path**: `returnPathStatus` (`ready|setup_required|unsupported|unknown`) and `returnReadiness` in `delegate`, `delegations`, `explain` and `doctor` are derived from current evidence each time, never from a flag. A background wait counts (`armed`) while its process (PID plus start time) and the ancestors that armed it are alive, it has not expired and it covers the delegation: unfiltered waits cover every delegation of the session, including later ones; `--correlation` one request; `--settled` the delegations open when armed; `--from`/`--type` none. A killed or timed-out wait is `not_armed`, a wait whose owner exited is `owner_lost`, and an arm whose process cannot be checked (or predates schema v6) is `unverified` (`unknown`). Heartbeats are app-only, so a Codex parent records a check-in on each run (`session update <me> --refresh`); one older than three binding `interval`s (default 15 minutes) is `stale` (`unknown`). Delegation rows keep the status proposed when they opened.
- **Delivery**: unseen → seen (by `wait`, the doorbell or explicit `read --mark-seen`) → acknowledged (by `ack`, or by settlement). Concurrent waits partition, they do not broadcast; run one watcher per session. `wait --replace` enforces that: it retires the caller's other running waits, which exit 0 with `reason: superseded` without claiming mail.
- **Worker contract v1**: delimited `<agentbus-contract version="1">` block naming request, worker, parent and provider, whose commands run a per-worker executable (`workerBin`, `<state-dir>/workers/<worker-id>/agentbus`) that fixes `--state-dir`, `--config` and `--as`; a single path, so it survives a shell variable in zsh and fish. The first Claude `UserPromptSubmit` carrying exactly one unquoted block, from the expected directory, claims the pending worker.
- **Observation**: Claude hooks and Codex runner events become turn bindings and observations. `turn_finished` notices are suppressed when that exact turn produced a question or result. Task notifications continue a delegated Claude turn only with proven provenance: a verified wait arm recorded by `agentbus wait` inside that turn, or a background task first seen in that turn's Stop inventory against a known baseline. Anything else supersedes the binding (phase `unknown`, `tracking_lost` notice).
- **Ordering**: hook events of one session commit in capture order. While any event of that session sits in the spool, later events drain it first or queue behind it; a delayed prompt or Stop never rebinds or overwrites a newer turn. Permission and failure events are posted only when attributable to a bound turn.

### Delivery and backlog metrics

```bash
agentbus metrics                          # caller as parent, all retained history
agentbus metrics --global --since 14d --group-by direction --json
agentbus metrics --global --since 2026-10-19T00:00:00+03:00 \
  --until 2026-10-29T00:00:00+03:00 --project /abs/project --group-by model
agentbus metrics --direction claude:codex --model gpt-6.1-sol --label kind=review
agentbus metrics --plain                  # versioned TSV summary
```

`metrics` opens SQLite read-only and takes one deferred snapshot. It never drains hooks, marks mail
seen, acknowledges it, changes delegation state or calls provider CLIs. Local process checks sample
watcher liveness after the database snapshot. Queued hook events remain outside the report until ingested.

**Selection is a delegation cohort:** `--since` is inclusive and `--until` exclusive, applied to
`delegations.opened_at`. All retained results, answers and receipts of those delegations are included,
including events after `--until`; this is not a historical as-of snapshot. Date-only bounds mean UTC;
ISO timestamps require a timezone. `--since` also accepts positive lookbacks such as `14d` from now.
`--project` selects the worker checkout and descendants, resolving existing symlink aliases and respecting
path boundaries. Use a parent directory to cover several checkouts; deleted paths can still match by
absolute path. `--direction` is `parent:worker`; `--model` is shorthand for the worker's `model` label.
Repeat `--label k=v` to intersect labels. Task kinds are explicit labels, not guesses from task names;
old delegations without that label do not match it.

Default scope is all retained delegations of the caller **as parent**. `--global` skips caller resolution.
Unrelated inbox mail is excluded. `--group-by project|direction|model|label:<key>` adds `groups` with the
same delegation/result/question/follow-up aggregates; missing labels form a null group. Root aggregates
always describe the whole selection. Pruning removes history. Empty selections return zero counts,
null oldest records and null statistics; a missing store exits 4.

JSON keeps the normal `schemaVersion`/`ok`/`data` envelope. **`data.metricsVersion: 2`** identifies the
extended report: `snapshotAt` is UTC ISO, `units` is `ms`, `scope` identifies the parent/global scope,
and `filters` contains normalized bounds, project, direction, labels and grouping.

| Field | Meaning |
| --- | --- |
| `delegations.total`, `withoutResult` | Selected delegations; open/closed without a result |
| `delegations.duration` | Open → terminal transition, including parent-closed work; open work is pending |
| `results.commitToSeen` | Result creation → recorded seen, including ack-inferred and historical seen |
| `results.seenToAck` | Recorded seen → acknowledgement; can be synthetic zero |
| `results.commitToAck` | Result creation → acknowledgement |
| `results.commitToDelivery`, `deliveryToAck` | Independent recorded delivery only; excludes ack-inferred and unknown historical seen |
| `results.seenSources` | Counts of `wait`, `doorbell`, `read`, `ack`, `settlement`, `legacy`, `unseen`, `missing` |
| `results.awaitingSeen`, `awaitingAck` | Pending result counts, unseen count and oldest record |
| `questionResponse` | Question count, answered count, closed-unanswered count, and first parent reply latency |

The commit timestamp approximates publication: `created_at` is captured inside the insertion transaction,
not at SQLite commit completion. Delivery means the page was committed for output, **not proof the
human/model consumed it**. Ordinary `read` stays non-mutating; `read --mark-seen` explicitly records
delivery of its returned page without accepting responsibility, before stdout. `--mark-seen` and `--ack`
are incompatible. Paginate using `hasMore`/`cursor`; recover unacknowledged mail from the beginning on
every wake even if already seen. Lost output remains recoverable with ordinary `read`.

Since schema 7, `receipts.seen_source` records the operation that first set `seen_at` (`seenSource` in
message envelopes). `ack`, `read --ack` and acknowledging replies synthesize source `ack` only when
previously unseen; automatic settlement uses `settlement`. Later operations never overwrite provenance.
Migration leaves historical provenance unknown: equal seen/ack timestamps do not establish how delivery
happened. `legacy` samples remain in the compatibility intervals but are `unobserved` in delivery-only
intervals; their true delivery latency cannot be recovered.

Each distribution has exclusive counts `measured`, `pending`, `missing`, `settled`, `invalid`, `unobserved`,
and `minMs`, `meanMs`, `maxMs`, `p50Ms`, `p90Ms`, `p95Ms` over measured samples. Percentiles use linear
interpolation at `(n−1)×p` (R-7); even-count p50 is the two middle values' midpoint. No samples means null,
not zero. `unobserved` excludes seen without independent delivery evidence; `settled` excludes automatic
receipt settlement or a closed unanswered question. Malformed/reversed intervals are invalid. These are
wall-clock durations, not model CPU time or cost; clock corrections can invalidate samples.

`questions` and `followups` remain active backlogs: `{count, unseen, oldest}`. Oldest records contain
`messageId`, `requestId`, `parentId`, `workerId`, `createdAt`, `ageMs` (future age clamps to zero).
A question remains unanswered until the parent replies to that exact ID; ack alone does not answer it.
`questionResponse` includes answered questions from terminal delegations too. Parent-to-worker follow-ups
include answers and exclude the initial request; seen without ack stays pending. Result/close removes
terminal leftovers from active backlogs, without pretending unanswered questions received an answer.

Without cohort filters, wait counts retain their original scope: all waits of the parent and delegated
workers, or every session for `--global`. With filters, waits must belong to a selected parent/worker,
match any recorded correlation and overlap its lifetime. A broad wait covering several
selected delegations counts once. Group aggregates omit watcher counts because one arm may cover
several groups.

`watchers` measures **wait arms**, not app heartbeat scheduling. `total` includes ended history; `ended`
arms are not stale. Each unended arm appears in `items` with scope, correlation, timestamps, age,
`processLiveness`/`ownerLiveness` (`alive|dead|unknown`), state and independent `expired`/`stale` flags.
`live`, `dead`, `ownerLost`, `unverified` partition unended arms. Death requires a successful local
process check proving the recorded PID/start identity absent or replaced. Owner lost means the wait
itself is alive and at least one recorded ancestor is confirmed dead. Missing identity, no owner evidence
or a failed process check is unverified, never proof of death. Filtered waits count as live when verified,
but their `scope` does not promise full delivery coverage; use `delegations`/`explain` for readiness.

`expired` means now reached `expires_at` (no grace); pre-v6 arms fall back to `created_at + MAX_WAIT_MS`
(24 hours), exposed as `effectiveExpiresAt`. `stale` is the union of expired, dead and owner lost arms,
**not a dead count**. These counts overlap: an expired arm can still be live or unverified. In contrast,
return-path readiness allows a 60-second expiry grace. A normal timeout records an ended arm and does
not prove process death. Heartbeat freshness remains a parent report shown by `delegations`/`explain`.

TSV: `metricsVersion` → 2. Columns: `snapshot` → timestamp, unit, scope, parent ID; `delegations` → total, without result;
`latency` → interval, measured, pending, missing, settled, invalid, min, mean, max, p50, p90, p95, unobserved;
`backlog` → name, count, unseen, oldest message ID, oldest age;
`watchers` → total, ended, unended, live, dead, owner lost, unverified, expired, stale.
Additional TSV rows: `filters` → normalized JSON; `seenSource` → source, count; `questionResponse` → total, answered, closed unanswered; `group` → field, JSON value, aggregate JSON. Missing TSV values use `-`. JSON watcher items grow with unended waits; retained history is scanned
locally on demand, without a telemetry service or scheduler.

### Codex runner events

The runner owning `codex exec --json` writes one JSON object per event and ingests it with `agentbus event ingest --provider codex --source runner --file <event>`:

```json
{ "schemaVersion": 1, "eventId": "<uuid>", "runId": "<uuid>", "ordinal": 0,
  "workerId": "<uuid>", "requestId": "<uuid>", "kind": "run_started",
  "capturedAt": "2026-10-01T08:00:00.000Z", "runDir": "/abs/run",
  "resumeThreadId": null, "runner": { "pid": 123, "start": "<ps -o lstart=>" } }
```

Kinds: `run_started` (before exec; `resumeThreadId` for resumes), `child_started` (`child` identity), `thread_started` (`threadId` from `thread.started`), `turn_started`, `run_finished` (`exit {code, signal}`, `turnCompleted`, `finalMessage`, `finalMessageFresh`, `error`). `(runId, ordinal)` deduplicates replays. A run is `turn_finished` only with exit 0, an observed `turn.completed` and a fresh final message; signals are `turn_interrupted`; everything else is `turn_failed`.

## Support matrix

| Capability | Claude worker | Codex worker | Claude parent | Codex parent |
| --- | --- | --- | --- | --- |
| Identity | `--as` baked into the contract's worker executable (bg Bash has no session env) | `AGENTBUS_SESSION_ID` from runner, plus `--as` | `CLAUDE_CODE_SESSION_ID` | `CODEX_THREAD_ID` |
| Binding | Contract claim on `UserPromptSubmit` + launcher `session bind` | Runner `thread_started` | — | — |
| Final response | `Stop.last_assistant_message` notice (fixture-verified) | Runner `run_finished` final message | — | — |
| Failure | `StopFailure` → `turn_failed` | Nonzero/incomplete run → `turn_failed` | — | — |
| Interruption | `SessionEnd` during an open turn; `--probe` PID+start death | Signal; `--probe` runner+child death | — | — |
| Launch failure | `--probe`: bound session listed as `failed`/`done`/`stopped` before any claimed turn → `launch_failed` (phase `interrupted`, job `detail` in the body) | — | — | — |
| Permission prompts | `PermissionRequest` (tool name + description only) | Not raised (`approval_policy=never`) | — | — |
| Follow-up delivery | Doorbell hook mid-turn (`PostToolUse`, `Stop`); the worker's own background wait after a question | `read` at milestones and before the result; in-turn wait, or parent resumes thread via launcher | — | — |
| Wake-up | — | — | Background `agentbus wait` (readiness from the live wait process) | Heartbeat (app tool; not callable from CLI; readiness from `session update --refresh` check-ins) |

Not covered by the selected hooks: tool-level progress, `SubagentStop`, `Notification` prompts (for example idle prompts), and permission prompts that do not raise `PermissionRequest`. Turns a user starts in Codex Desktop are never attributed (no runner).

## Verification

```bash
bun run gate
```

Runs Biome lint, `tsc --noEmit` (TypeScript 7), `test:integration` (mailbox, delegation, concurrency, wait, CLI) and `test:e2e` (Claude hook lifecycle from recorded payloads, Codex runner events, probes with real processes and a fake `claude` inventory, the follow-up completion gate including concurrent follow-up/result races, return-path readiness with real wait processes, and `explain` across delegation situations). All checks drive the public CLI in subprocesses against temporary stores; none touch `~/.claude` or the real mailbox. Fault injection for recovery checks: `AGENTBUS_FAULT_INJECT=wait-after-seen-commit|hook-spool`.

### Opt-in Codex heartbeat restart gate

The [restart workflow](docs/heartbeat-restart.md) prepares private state, a complete static continuation prompt, unread and seen-but-unacknowledged results, and a guard delegation before any restart. `scripts/heartbeat-restart.ts` drives the public CLI, verifies the original native chat and saved automation intent, detects changed Desktop PID/start identity with the old owner confirmed dead, paginates fresh recovery sweeps, records keyed handling before ack, and gates final cleanup. It never restarts the app, launches a model, edits app-owned state, or installs the binary. The current app's card-only automation view is retained alongside a read-only config snapshot, explicitly weaker than observed scheduler execution.

Process checks cover interrupted handling/retry, two-page recovery, identity/automation mismatch, card-only API receipts, keyed results and guarded cleanup. They are fixture evidence. The [2026-10-06 live preflight](docs/live/heartbeat-restart-2026-10-06.md) verified create/view/configuration/deletion and native identity, but **did not restart the app** because an unrelated local chat was active. Both disposable automations were deleted and their stores marked aborted; automatic resumption and result recovery after a real restart remain unverified. A saved automation ID or green package gate does not pass that acceptance criterion.

Recorded evidence lives in `tests/fixtures/` (Claude Code 2.1.284, Codex CLI 0.157.1); `*.synthetic.json` files follow the documented hook shapes where no live capture exists yet.

### Live checks

Verified on 2026-10-01 with five disposable Haiku `--bg` workers using per-worker `--settings` hooks (see [Pre-implementation evidence](docs/history.md#pre-implementation-evidence)): contract claim, result attribution and Stop suppression, fallback `turn_finished`, question → background-wait wake-up → result, `PermissionRequest` with `prompt_id`, `claude stop` mid-turn → `turn_interrupted`, and `kill -9` → stale `claude agents` row but probe-confirmed `turn_interrupted`.

Claude→Codex live gate (2026-10-01): a real `codex exec` worker asked a question, the Claude parent's background `agentbus wait` re-invoked it, the answer went through `spawn.sh --resume` on the same thread ID, and the result arrived through a second wake-up.

`claude-threads` on Agentbus (2026-10-01, Claude Code 2.1.284, seven disposable Haiku children, one lead watcher armed with `wait --replace --probe 60s`): phases matched each child (`question`, `permission`, `question`, then `done`/`interrupted`/`unknown`); a question → answer → the child's own background wait → result round-trip produced no `turn_finished` notice; a child spawned after the watcher was armed (in a `claude --worktree` worktree, claimed through `delegate --allow-missing-cwd`) reported to the same watcher; a `kill -9` of an idle owner with an armed wait was confirmed dead by the probe with no hook (`turn_interrupted`; the daemon respawned the owner 3 s later); `cleanup.sh rm` removed sessions, worktrees and branches and closed open delegations.

Finding from the same run: the Claude daemon respawns a killed background owner (same session, new PID, `SessionStart source=resume`, same `--settings`) — mid-turn it resumes the turn and re-raises a pending permission prompt. The respawned owner does not adopt the old owner's background tasks: the orphaned wait consumed the parent's answer and the child was never re-invoked. Agentbus now posts `tracking_lost` (phase `unknown`, not repaired by a live-owner probe) when a resumed owner starts while the bound turn's background work is outstanding; a lead recovers with a provider-native doorbell (`SendMessage` to the child), verified live.

Codex→Claude live gate (2026-10-04, real tasks through tracked `codex-to-claude`, Codex app heartbeats `FREQ=MINUTELY;INTERVAL=5`): a worker's `result/success` committed at 16:03:46Z; the parent chat's heartbeat turn started at 16:04:49Z (63 s), read and acknowledged it at 16:06:20Z, and the heartbeat deleted itself once the chat's only delegation closed. A second chat's heartbeat stayed active while its delegation was open.

Same day, real use exposed the missing mid-task channel: a Codex parent sent three follow-ups to working Claude workers, none was read, and both workers published their results without them. Follow-ups now join the delegation and ring the doorbell. Doorbell live check (Claude Code 2.1.287, two disposable Haiku workers, isolated store): a follow-up sent during a worker's foreground command was announced by `PostToolUse` 7 s later, read, acked and honored in the result; one sent while a worker wrote a tool-free reply blocked its `Stop` (“Stop hook feedback”), after which it read, acked and published the requested result. Neither worker had a wait armed.

Still open:

- Claude: session UUID and `prompt_id` across Desktop resume, and whether per-worker `--settings` hooks stop there; background wait re-invocation in a Desktop-owned session.
- Codex: heartbeat persistence, automatic original-chat resumption and result recovery after an app restart. `CODEX_THREAD_ID` was present in this Desktop chat's tool shells on 2026-10-06; other versions/hosts still require identity verification before check-in.
