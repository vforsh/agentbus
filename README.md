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
| 6. Codex wake adapter | Not started (conditional on a spike) |

Live gates that passed are listed under [Live checks](#live-checks); everything else is proven by fixture-driven checks for recorded payload shapes, not live delivery.

## Install

Requires Bun ≥ 1.4.2 (developed on `1.4.2+744846f84`; macOS system SQLite `3.43.2`, rollback journal).

```bash
cd ~/dev/agentbus && bun install && bun link
```

```bash
bun run install:bin
```

```bash
agentbus init
```

```bash
agentbus doctor
```

After pulling changes, rebuild with `bun run install:bin` and run `agentbus init` to apply schema migrations; commands refuse an older schema until then.

`install:bin` compiles a standalone executable to `${XDG_DATA_HOME:-~/.local/share}/agentbus/bin/agentbus` (~60 MB, includes the Bun runtime). Worker contracts and hooks run that copy whenever it exists. Background Claude sessions can be denied reads on external volumes by macOS privacy controls (observed: `stat` succeeds, `read` fails with `Operation not permitted`), so the CLI that workers execute must live on the internal disk. Rebuild after changing the checkout; `agentbus doctor` warns when the installed copy is stale or when workers would run from an external volume.

State lives in `${XDG_STATE_HOME:-~/.local/state}/agentbus/` (internal disk, `0700`/`0600`); config in `${XDG_CONFIG_HOME:-~/.config}/agentbus/config.json`. Override with `--state-dir`/`--config` or `AGENTBUS_STATE_DIR`/`AGENTBUS_CONFIG`.

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

# Worker (follows the generated <agentbus-contract> block)
agentbus --as <worker-id> read --correlation <request-id> --json
agentbus --as <worker-id> ack <request-id>
agentbus --as <worker-id> reply <request-id> --type result --outcome success --key result-1 \
  --summary "Parser fixed; tests pass" --file result.md

# Parent, re-invoked by its wait
agentbus read --json
agentbus ack <result-id>
agentbus delegations
```

## Commands

```text
agentbus init | whoami | doctor|check | skill | completion <fish|zsh|bash>
agentbus session register|bind|list|show|update
agentbus delegate --to <claude|codex> --file <path|-> [--name] [--cwd] [--allow-missing-cwd] [--key] [--summary] [--label k=v]... [--contract-out] [--dry-run]
agentbus delegations [<request-id|name>...] [--all] [--global] [--probe]
agentbus send <recipient> --file <path|-> [--type message|request] [--key] [--summary] [--dry-run]
agentbus reply <message-id> --file <path|-> [--type message|progress|question|result] [--outcome] [--key] [--summary]
agentbus read [--all] [--unseen] [--after <seq>] [--from] [--type] [--correlation] [--limit]
agentbus wait [--timeout 60s] [--settled] [--probe <interval>] [--replace] [--after] [--from] [--type] [--correlation] [--limit]
agentbus ack <message-id...> | close <request-id|name>
agentbus status [<session>] [--probe]
agentbus event ingest --provider claude --source hook        # stdin, silent; used by hooks
agentbus event ingest --provider codex --source runner --file <event.json>
agentbus event drain
agentbus hooks claude print|install|uninstall|status [--dry-run]
agentbus config|cfg list|ls|path|get|set|unset|import|export
```

Global: `--as`, `--config`, `--state-dir`, `--json`, `--plain`, `-q`, `-v`, `--no-color`, `--no-input`, `--version`, `-h`.

### Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Success (for `send`, the message is committed) |
| 1 | Unexpected failure; `doctor` not ready; `hooks claude status` not current |
| 2 | Invalid usage or input (bad flags, >1 MiB body, malformed UTF-8) |
| 3 | `wait` timed out: empty list, `timedOut: true`; run the recovery `read` anyway |
| 4 | Session, message, delegation or store not found |
| 5 | Conflict: retry key reuse, ambiguous identity, wrong role/recipient, closed delegation, busy worker, binding conflict |
| 6 | Database busy past the deadline (5 s for commands, 1 s for hooks) |
| 130 | Interrupted |

`--json` prints exactly one `{"schemaVersion":1,"ok":...}` object per invocation, including failures.

## Protocol

- **Envelope v1**: `id`, `sequence`, `from`, `to`, `type` (`message|request|progress|question|result|notice`), `summary`, `body`, `createdAt`, `correlationId` (root request), `inReplyTo`, `idempotencyKey`, `outcome` (results only), `notice` (`{kind, observationId, provider, truncated?, originalBytes?}`), `turnRef`, `seenAt`, `acknowledgedAt`.
- **Roles**: `progress`/`question`/`result` go from a delegation's worker to its parent via `reply`; a parent answers with a `message` reply to the question ID. Notices come only from `system:observer` and cannot be replied to. One open delegation per worker, one unresolved question per delegation; every result is terminal.
- **Follow-ups**: a parent's `send` to the worker of its open delegation joins that delegation's correlation; Claude workers get it through the doorbell mid-turn.
- **Settlement**: a delegation's terminal transition acknowledges mail nobody needs to handle any more, with `settledReason`: a result settles the worker's side (`delegation_done`), a parent's `close` the whole correlation (`delegation_closed`). The result itself stays with the parent.
- **Delivery**: unseen → seen (by `wait` or the doorbell) → acknowledged (by `ack`, or by settlement). Concurrent waits partition, they do not broadcast; run one watcher per session. `wait --replace` enforces that: it retires the caller's other running waits, which exit 0 with `reason: superseded` without claiming mail.
- **Worker contract v1**: delimited `<agentbus-contract version="1">` block naming request, worker, parent and provider, with exact commands including `--state-dir`, `--config` and `--as`. The first Claude `UserPromptSubmit` carrying exactly one unquoted block, from the expected directory, claims the pending worker.
- **Observation**: Claude hooks and Codex runner events become turn bindings and observations. `turn_finished` notices are suppressed when that exact turn produced a question or result. Task notifications continue a delegated Claude turn only with proven provenance: a verified wait arm recorded by `agentbus wait` inside that turn, or a background task first seen in that turn's Stop inventory against a known baseline. Anything else supersedes the binding (phase `unknown`, `tracking_lost` notice).
- **Ordering**: hook events of one session commit in capture order. While any event of that session sits in the spool, later events drain it first or queue behind it; a delayed prompt or Stop never rebinds or overwrites a newer turn. Permission and failure events are posted only when attributable to a bound turn.

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
| Identity | `--as` from contract (bg Bash has no session env) | `AGENTBUS_SESSION_ID` from runner, plus `--as` | `CLAUDE_CODE_SESSION_ID` | `CODEX_THREAD_ID` |
| Binding | Contract claim on `UserPromptSubmit` + launcher `session bind` | Runner `thread_started` | — | — |
| Final response | `Stop.last_assistant_message` notice (fixture-verified) | Runner `run_finished` final message | — | — |
| Failure | `StopFailure` → `turn_failed` | Nonzero/incomplete run → `turn_failed` | — | — |
| Interruption | `SessionEnd` during an open turn; `--probe` PID+start death | Signal; `--probe` runner+child death | — | — |
| Launch failure | `--probe`: bound session listed as `failed`/`done`/`stopped` before any claimed turn → `launch_failed` (phase `interrupted`, job `detail` in the body) | — | — | — |
| Permission prompts | `PermissionRequest` (tool name + description only) | Not raised (`approval_policy=never`) | — | — |
| Follow-up delivery | Doorbell hook mid-turn (`PostToolUse`, `Stop`); the worker's own background wait after a question | `read` at milestones and before the result; in-turn wait, or parent resumes thread via launcher | — | — |
| Wake-up | — | — | Background `agentbus wait` | Heartbeat (app tool; not callable from CLI) |

Not covered by the selected hooks: tool-level progress, `SubagentStop`, `Notification` prompts (for example idle prompts), and permission prompts that do not raise `PermissionRequest`. Turns a user starts in Codex Desktop are never attributed (no runner).

## Verification

```bash
bun run gate
```

Runs Biome lint, `tsc --noEmit` (TypeScript 7), `test:integration` (mailbox, delegation, concurrency, wait, CLI) and `test:e2e` (Claude hook lifecycle from recorded payloads, Codex runner events, probes with real processes and a fake `claude` inventory). All checks drive the public CLI in subprocesses against temporary stores; none touch `~/.claude` or the real mailbox. Fault injection for recovery checks: `AGENTBUS_FAULT_INJECT=wait-after-seen-commit|hook-spool`.

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
- Codex: `CODEX_THREAD_ID` in Desktop tool shells (heartbeat prompts pass `--as codex:<thread-id>` explicitly).
