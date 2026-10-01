# agentbus

Durable local mailbox and delegation bus between Codex and Claude Code sessions. A parent delegates a task to a worker session; progress, questions, results and observed lifecycle notices come back to the parent's inbox. Messages are committed to SQLite before any receipt is printed and stay recoverable until acknowledged.

Design and rationale: [PLAN.md](PLAN.md). Agent-facing usage: [skill/agentbus/SKILL.md](skill/agentbus/SKILL.md).

## Status

| Milestone | State |
| --- | --- |
| 1. Scaffold, contracts, config, diagnostics | Implemented |
| 2. Durable mailbox (sessions, messages, receipts, delegations, waits) | Implemented; acceptance 1–4 covered by process-level checks |
| 3. Worker result capture (Claude hooks + spool, Codex runner events, probes, phases) | Implemented at the adapter level with recorded fixtures; live Claude checks below still open |
| 4. Launcher integration and live Codex↔Claude workflows | Not started: consumer skill and README done; `codex-to-claude` / `claude-to-codex` changes and live gates pending |
| 5. `claude-threads` on Agentbus | Not started |
| 6. Codex wake adapter | Not started (conditional on a spike) |

Nothing here is verified end to end between live providers yet. Fixture-driven checks prove the adapters' behavior for recorded payload shapes, not live delivery.

## Install

Requires Bun ≥ 1.4.2 (developed on `1.4.2+744846f84`; macOS system SQLite `3.43.2`, rollback journal).

```bash
cd ~/dev/agentbus && bun install && bun link
```

```bash
agentbus init
```

```bash
agentbus doctor
```

State lives in `${XDG_STATE_HOME:-~/.local/state}/agentbus/` (internal disk, `0700`/`0600`); config in `${XDG_CONFIG_HOME:-~/.config}/agentbus/config.json`. Override with `--state-dir`/`--config` or `AGENTBUS_STATE_DIR`/`AGENTBUS_CONFIG`.

### Claude hooks

Worker turn capture needs user-level hooks in `~/.claude/settings.json`. Install is idempotent, preserves unrelated entries and writes a private backup next to the file:

```bash
agentbus hooks claude install --dry-run
```

```bash
agentbus hooks claude install
```

Each entry pins the absolute Bun runtime, CLI path, store and config, guarded so an unmounted checkout volume is a silent no-op. Hooks print nothing, always exit 0, and do one read-only lookup (~31 ms measured) for sessions Agentbus does not know. `agentbus hooks claude status` verifies; `uninstall` removes only Agentbus-owned entries.

### Config keys

| Key | Default | Purpose |
| --- | --- | --- |
| `stateDir` | XDG state dir | Store location (flags and env win) |
| `claudeBin` / `codexBin` | `claude` / `codex` on PATH | Provider executables used by probes |
| `claudeSettingsPath` | `~/.claude/settings.json` | Target of `hooks claude` |
| `claudeJobsDir` | `~/.claude/jobs` | Optional job diagnostics for `--probe` |
| `cliCommand` | `<bun> <checkout>/bin/agentbus` | Command rendered into worker contracts |

```bash
agentbus config set codexBin=/opt/homebrew/bin/codex
```

## Quick start

```bash
# Parent (Claude Desktop session; identity from CLAUDE_CODE_SESSION_ID)
agentbus session register --provider claude --external-id "$CLAUDE_CODE_SESSION_ID" --name lead
agentbus delegate --to codex --name executor --cwd ~/dev/project --key task-002 --file request.md --json
agentbus wait --timeout 30m --probe 60s --json        # as a background command

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
agentbus delegate --to <claude|codex> --file <path|-> [--name] [--cwd] [--key] [--summary] [--label k=v]... [--contract-out] [--dry-run]
agentbus delegations [<request-id|name>...] [--all] [--probe]
agentbus send <recipient> --file <path|-> [--type message|request] [--key] [--summary] [--dry-run]
agentbus reply <message-id> --file <path|-> [--type message|progress|question|result] [--outcome] [--key] [--summary]
agentbus read [--all] [--unseen] [--after <seq>] [--from] [--type] [--correlation] [--limit]
agentbus wait [--timeout 60s] [--settled] [--probe <interval>] [--after] [--from] [--type] [--correlation] [--limit]
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
- **Delivery**: unseen → seen (by `wait`) → acknowledged (by `ack`). Concurrent waits partition, they do not broadcast; run one watcher per session.
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
| Permission prompts | `PermissionRequest` (tool name + description only) | Not raised (`approval_policy=never`) | — | — |
| Follow-up delivery | Worker's own background wait | In-turn wait, or parent resumes thread via launcher | — | — |
| Wake-up | — | — | Background `agentbus wait` | Heartbeat (app tool; not callable from CLI) |

Not covered by the selected hooks: tool-level progress, `SubagentStop`, `Notification` prompts (for example idle prompts), and permission prompts that do not raise `PermissionRequest`. Turns a user starts in Codex Desktop are never attributed (no runner).

## Verification

```bash
bun run gate
```

Runs Biome lint, `tsc --noEmit` (TypeScript 7), `test:integration` (mailbox, delegation, concurrency, wait, CLI) and `test:e2e` (Claude hook lifecycle from recorded payloads, Codex runner events, probes with real processes and a fake `claude` inventory). All checks drive the public CLI in subprocesses against temporary stores; none touch `~/.claude` or the real mailbox. Fault injection for recovery checks: `AGENTBUS_FAULT_INJECT=wait-after-seen-commit|hook-spool`.

Recorded evidence lives in `tests/fixtures/` (Claude Code 2.1.284, Codex CLI 0.157.1); `*.synthetic.json` files follow the documented hook shapes where no live capture exists yet.

### Open live checks (milestone 3–4 gates)

- Claude: session UUID, hooks and `prompt_id` across Desktop resume; background wait re-invocation in a Desktop-owned session; `SessionEnd` on `claude stop` mid-turn; `claude agents` after `kill -9`; real `PermissionRequest` payloads.
- Codex: `codex exec resume` keeps the thread ID; `CODEX_THREAD_ID` in Desktop tool shells; heartbeat create/run/cleanup.
- Launchers: durable launch manifests, cross-run ownership lock and persisted Desktop-open marker in `claude-to-codex`; fresh-idle handoff guard in `codex-to-claude`.
