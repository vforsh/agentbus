# Agentbus implementation plan

Status: proposed design, revised on 2026-10-01 for Claude→Claude delegation and the `claude-threads` migration; implementation has not started.

Agentbus is a local CLI for communication between agent sessions. It supports delegation in every direction between Codex and Claude Code:

- A Codex thread delegates work to a Claude Code session.
- A Claude Code session delegates work to a Codex thread.
- A Claude Code session leads several Claude Code child sessions; this replaces the tracking half of the `claude-threads` skill.

In each case the parent receives progress, questions and the result in its original conversation. The mailbox is provider-agnostic; provider adapters handle observation and wake-up.

Deliver in order of certainty: durable messaging, then worker result capture, then end-to-end delegation between providers, then `claude-threads` on Agentbus, and only then an automatic Codex wake adapter. Storing a message, requesting a new turn, acknowledging a message and completing a task remain separate events.

## Initial scope and decisions

| Decision | Initial implementation |
| --- | --- |
| Directory | `~/dev/agentbus`; `~/dev` is a symlink to `/workspace` |
| Command | `agentbus` |
| Package | `@vforsh/agentbus` (free on npm as of 2026-09-30); repository `vforsh/agentbus`, private |
| Runtime | Latest stable Bun at implementation time, latest stable TypeScript; Bun tooling throughout |
| Dependencies | Commander for arguments, Zod for boundary validation, Picocolors for human output |
| Storage | SQLite through `bun:sqlite`, rollback journal; SQL migrations and prepared statements |
| Platforms | macOS first; keep the mailbox portable to Linux |
| Deployment | Local checkout and `bun link` after implementation passes its gates |
| Directions | Codex→Claude, Claude→Codex and Claude→Claude are verified. Codex→Codex is allowed by the protocol but not verified |
| Launching | The skills `codex-to-claude`, `claude-to-codex` and `claude-threads` remain the launchers. They share one Agentbus sequence: `delegate`, spawn, `session bind` |
| Process model | Short-lived CLI processes, Claude hooks and the existing `codex exec` runner; no daemon or long-running worker unless a verified wake adapter ships |
| Trust boundary | One OS user on one host; session identities are routing labels, not authenticated principals |
| Verification | Integration, process-level and end-to-end checks; no unit tests or unit-test targets |

The first release supports one recipient per message and text payloads. Cross-host routing, remote authentication, a web UI, file synchronization, retention/pruning and automatic task execution are later extensions. Agentbus supplies identity, correlation, result capture, delegation state, the worker contract and parent wake-up. The launcher skills keep model, permission, worktree and Desktop-handoff logic.

## Roles and paths

Every delegation has a **parent** (the requester) and a **worker** (the recipient of the request). The provider of each role determines how events are observed and how the other side is woken. Claude→Claude combines the Claude rows of both roles.

| | Claude | Codex |
| --- | --- | --- |
| **As worker: launched by** | `codex-to-claude` or `claude-threads` → `claude --bg` | `claude-to-codex` → detached runner around `codex exec` |
| **As worker: observed through** | User-level Claude hooks, across the Desktop handoff | The runner, while `codex exec` owns the thread |
| **As worker: follow-up delivery** | Live session: the worker arms a background wait after asking | In-turn wait, or the parent resumes the thread with `codex exec resume` |
| **As parent: woken by** | One background `agentbus wait`, covering all its delegations | A heartbeat on the original chat; automatic wake is milestone 6 |
| **As parent: identity** | `CLAUDE_CODE_SESSION_ID` in Desktop sessions, otherwise explicit | `CODEX_THREAD_ID` |

Tracking a Codex worker is required only while `codex exec` owns it. Once the user opens the thread in Codex Desktop, Desktop owns it: explicit mailbox replies still work, and lifecycle observation becomes best effort (optional Codex hooks, milestone 7).

## Acceptance criteria

First release (milestones 1–4):

1. Two independent processes can register sessions, exchange a request and reply, and acknowledge messages through the installed CLI.
2. A committed message survives sender exit, reader interruption and a subsequent CLI process reopening the database.
3. Repeating a send with the same sender and idempotency key returns the existing message; changing its payload produces a conflict.
4. Reading or waiting does not consume a message: it stays pending until its recipient explicitly acknowledges it. `wait` returns each message once by marking it seen, so re-arming never spins and needs no client-side cursor.
5. Worker permission prompts, turn failures, interruptions and normal turn ends produce distinct observer notices. Finishing a turn never means the task succeeded; only a worker-authored `result` carries an outcome.
6. When a delegated Claude turn finishes, the parent's inbox contains Claude's final response with no Agentbus process running other than the hook, including after the background owner has been released to Desktop.
7. When a delegated `codex exec` run finishes or fails, the parent's inbox contains Codex's final message or the failure, reported by the runner.
8. Later turns that were not started for the delegation are not attributed to it: a manual Claude prompt, or a Codex turn outside the runner.
9. A Codex parent collects the result after its initial turn has ended, through a heartbeat or a verified wake adapter. A missing adapter leaves the message available and reports the missing capability.
10. A Claude parent is re-invoked by its background wait when a question, result or notice arrives, without user input. Answering a Codex worker's question resumes the same thread ID without a fork, and is refused while the run is active or after Desktop may have taken the thread.
11. Hooks exit 0 quickly and write nothing for unregistered sessions or when Agentbus is unavailable, for example while the external volume holding the checkout is unmounted.
12. Help, diagnostics and JSON errors are useful without exposing payload bodies in routine logs.

`claude-threads` on Agentbus (milestone 5):

13. One armed wait wakes a Claude lead for any event from any of its Claude children, including children spawned after the wait was armed. A child's explicit question or result is never followed by a redundant `turn_finished` notice for the same turn.
14. `agentbus delegations` shows each child's phase, which matches the observed events: working, permission, question, idle, interrupted, done or closed. A child killed without any hook firing is reported as interrupted by `wait --probe`.

Wake adapter, required only if milestone 6 ships one:

15. A wake attempt reports its actual stage: pending, accepted, unsupported, failed or uncertain. It never claims the model read a message based only on provider acceptance.
16. Killing and restarting a wake worker cannot silently drop a wake or cause two workers to dispatch the same wake.

## Architecture

```mermaid
flowchart LR
    CX[Codex thread] -->|send, reply, read, ack| CLI[Agentbus CLI]
    CL[Claude session] -->|send, reply, read, ack| CLI
    L[Launcher skills] -->|delegate, bind| CLI
    CH[Claude user hooks] -->|event ingest| CLI
    CR[codex exec runner] -->|event ingest| CLI
    HB[Codex heartbeat] -->|wait| CLI
    BW[Claude background wait] -->|wait| CLI
    CLI --> DB[(SQLite mailbox)]
    DB -. milestone 6 .-> W[Wake worker] -.-> CX
```

Use three layers:

- **Mailbox:** sessions, immutable messages, per-message seen and acknowledgement state, delegations with derived phases, and normalized observations. It knows nothing about providers beyond identity formats.
- **Provider adapters:** Claude hook ingestion and on-demand probing of `claude agents` and Claude job state; ingestion of Codex runner events; later, wake dispatch through verified interfaces only.
- **Agent workflow:** one consumer skill covers both roles: when to read, reply and acknowledge, which task scope is authorized, how to wait as a parent, and how to act on another agent's result. The per-provider worker contract is generated by `agentbus delegate`, so launchers do not each maintain their own.

The mailbox must work with provider adapters disabled. Core commands neither launch models nor require a running daemon. Adapters must not edit another product's database or state files, inject keystrokes, or treat terminal redraws as a message protocol.

### Sessions and addressing

Each registered session has an internal UUID, provider, native identifier, display name, canonical project directory, labels and adapter binding:

- Provider values are `codex`, `claude` and `generic`, plus the reserved `system` provider. The initial migration creates `system:observer`; users cannot register `system` sessions.
- Labels are a small string map (at most 16 entries), for example `model=opus`, `effort=xhigh` or `worktree=review-api`. They are display metadata shown in tables and never used for routing.
- The adapter binding holds provider-specific handles: the Claude short ID, or the Codex runner directory and PID.

Accept either an internal UUID or `provider:<native-id>` as an address. Names are display metadata, not routing addresses; a name may also select a delegation in `delegations` and `close` when it is unambiguous among the caller's own delegations. Resolve one exact match; reject ambiguity and unknown recipients. Native IDs are full lowercase UUIDs; the short IDs printed by `claude --bg` are CLI handles, not identities.

Registration is idempotent on `(provider, external_id)` within this host's store. `--cwd` defaults to the current directory. Preserve the supplied directory for display and its resolved real path for comparison, since `~/dev` resolves to `/workspace`. A changed backend binding requires an explicit update and revalidation.

**Pending workers.** A worker's native ID is unknown until it starts, and it may act before the launcher reads that ID back. Every launcher therefore opens the delegation before spawning:

1. `agentbus delegate --to <claude|codex> --file <request>` creates a pending worker session (internal UUID, no native ID). In the same transaction it sends the request and opens the delegation. It returns the worker ID, the request ID and the worker contract.
2. The launcher appends the contract to the worker prompt and spawns the worker.
3. The native ID is bound once known:
   - Claude: `claude --bg --session-id <uuid>` silently ignores the flag. The first `UserPromptSubmit` from an unregistered session whose prompt contains the token of an open delegation with a pending worker claims it in one transaction. The launcher then confirms with `session bind`, using the UUID from `claude agents --all --json`, and records the short ID in the adapter binding.
   - Codex: the runner reads `thread_id` from the `thread.started` event of `codex exec --json` and runs `session bind`, recording its run directory and PID. No hook is involved.
4. `session bind` succeeds when the binding already matches and fails with a conflict when it differs.

A pending session never matches unrelated sessions, because claiming requires the exact token. Delivery works before binding: messages address the internal UUID.

**Caller resolution**, first match wins:

1. `--as <address>`.
2. `AGENTBUS_SESSION_ID`.
3. Native session environment: `CLAUDE_CODE_SESSION_ID` maps to `claude:<id>`, and `CODEX_THREAD_ID` maps to `codex:<id>`. Ignore `CLAUDE_CODE_HOST_SESSION_ID`, which identifies the Desktop host.

Native detection refuses to guess when markers from more than one provider are present. This happens in practice: a `codex exec` started from Claude inherits the parent's `CLAUDE_CODE_SESSION_ID` next to its own `CODEX_THREAD_ID`. Workers resolve identity as follows:

- **Codex worker:** the runner sets `AGENTBUS_SESSION_ID=<worker-id>`, which `codex exec` passes to tool shells, and removes the inherited `CLAUDE_CODE_SESSION_ID` from the worker environment.
- **Claude worker:** `claude --bg` passes neither the launcher's environment nor `CLAUDE_CODE_SESSION_ID` to its Bash tool, so it uses the explicit `--as` from its contract.

The ambiguity rule cannot catch a same-provider leak, where a Claude child would inherit its Claude lead's ID. So the contract always names the worker's address explicitly. The protocol also blocks impersonation structurally: only the request's recipient can acknowledge it or reply to it, so a worker acting as its parent fails instead of answering itself. `whoami` prints the resolved address, its source and registration state. Sending, replying, acknowledging and closing require a registered caller; registration, `whoami` and diagnostics do not.

### Message contract

Use a versioned envelope with these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Envelope version, initially `1` |
| `id` | Random UUID; stable across retries |
| `sequence` | Database insertion order; JSON integer |
| `from`, `to` | Internal session UUIDs |
| `type` | `message`, `request`, `progress`, `question`, `result` or `notice` |
| `summary` | Optional single line, at most 200 characters, shown in tables and listings; notices get one derived from their excerpt |
| `body` | UTF-8 text, copied into SQLite rather than retained only as a file path |
| `createdAt` | UTC timestamp |
| `correlationId` | Root request ID; new requests default to their own message ID |
| `inReplyTo` | Optional parent message ID |
| `idempotencyKey` | Optional caller-supplied retry key, unique per sender |
| `outcome` | For `result` only: `success`, `blocked`, `failed` or `unknown` |
| `notice` | For `notice` only: `{kind, observationId, provider}`; kind is `turn_finished`, `turn_failed`, `turn_interrupted` or `permission_request` |
| `seenAt`, `acknowledgedAt` | Recipient state, derived from their tables; nullable; not part of the idempotency hash |

Authorship rules make evidence structural rather than a naming convention:

- `result` is authored by the worker and is the only type that carries an outcome. A failed task is `result` with `outcome: failed`; there is no separate error type.
- `notice` is authored only by `system:observer`. Its body is the relevant excerpt: the worker's last assistant message for `turn_finished`, or the tool name and a short input summary for `permission_request`. Notices cannot be replied to.

`reply` derives the recipient and correlation ID from the original message. Only the original recipient can reply through this operation. Keep raw provider payloads in observations, never in ordinary messages.

A `request` (sent directly or through `delegate`) opens a delegation, keyed by the request message ID, in the same transaction. It records the parent, worker and state. It closes when the worker replies with `result` or when the parent runs `close`. It does **not** close when a provider process ends: `claude stop` during Desktop handoff and every `codex exec` exit both fire `SessionEnd`, while the conversation continues.

Use a proposed 1 MiB body limit to accommodate long handoff packets while bounding memory and database growth. Reject invalid UTF-8, unsupported envelope versions and excess input with actionable errors. Referenced project artifacts remain ordinary paths; copying attachments is a later feature.

### Delivery, seen state and retries

Messages are committed before any success receipt is printed. Delivery is at-least-once; Agentbus does not promise exactly-once task execution.

Each recipient message moves through three states: **unseen**, **seen** and **acknowledged**.

- `wait` returns unseen messages matching its filters and marks them seen in the same transaction that selects them, then prints them. A re-armed wait therefore returns only newer messages, without a client-side cursor. This is essential for a heartbeat, whose prompt is static and cannot carry a cursor between wakes.
- `read` returns every unacknowledged message by default and changes nothing. `read --unseen` behaves like a non-blocking `wait`.
- `ack` means the receiving workflow accepted responsibility.

Seen is a delivery hint, not consumption. If a wait's output is lost, the message stays visible to `read` until acknowledged, and the skill always runs `read` after waking.

Scope idempotency keys to the sender. Compare a canonical hash of recipient, body, summary, type, correlation, reply target and outcome on retry. Reusing a key for a different request fails. An unkeyed send creates a fresh message, so automated producers must supply stable keys.

Acknowledgements are idempotent and recipient-scoped. They do not prove a task succeeded or even that a provider started a model turn. Support multiple acknowledgements atomically; validate the complete set first.

Every `read` and `wait` receipt still includes `cursor`, the highest returned `sequence`, and both accept `--after <cursor>` to page through history. Cursors navigate history; they never acknowledge or mark anything.

### Observation and task outcome

Keep these independent:

- Session activity: `running`, `awaiting_input`, `idle`, `stopped` or `unknown`.
- Native owner: `background`, `desktop`, `exec`, `interactive` or `unknown`.
- Observed lifecycle event: `turn_started`, `turn_finished`, `turn_failed`, `turn_interrupted`, `permission_request` or `owner_released`.
- Explicit request outcome: `success`, `blocked`, `failed` or `unknown`.

Activity and owner come only from an explicit probe or the latest runner event, and are never cached as truth. Lifecycle events come from Claude hooks, the Codex runner and `wait --probe`. Each observation records its source (`claude-hook`, `codex-runner` or `probe`), timestamp, delegation and native turn ID when available. `owner_released` is recorded but posts no notice. Outcome comes only from a worker-authored `result`. Missing process metadata is unknown state, not successful completion.

The observation event ID is derived from `(provider, session, turn ID, event)` when a turn ID exists, and is random otherwise. Duplicate reports of the same turn therefore ingest once, which also covers optional Codex hooks later reporting a turn the runner already reported.

**No redundant notices.** A `turn_finished` notice is posted only if the worker sent no `question` or `result` during that bound turn; `progress` does not count. A worker that reports explicitly wakes its parent once, with its own message. This replaces the transcript parsing that `claude-threads` uses to detect whether a child already messaged its lead.

**Interruption.** `turn_interrupted` is posted in either case:

- `SessionEnd` arrives while a bound turn is open: `UserPromptSubmit` was seen with no `Stop` after it, for example `claude stop` mid-turn.
- `wait --probe` finds the worker's process gone while its phase is `working` or `permission`: a Claude row missing or `stopped` in `claude agents`, or a dead Codex runner PID.

### Delegation phase

Each open or recent delegation has a derived **phase**, computed from its messages and observations rather than from provider classifiers. It replaces the model-classified `done`/`blocked`/`working` states that `claude-threads` has to second-guess.

| Phase | Derived when |
| --- | --- |
| `pending` | Request sent; the worker is not bound or has not started a bound turn |
| `working` | A bound turn started and has not finished |
| `permission` | A `permission_request` arrived during the current bound turn |
| `question` | The worker's latest explicit message is a `question` with no parent reply after it |
| `idle` | The last bound turn finished with no question or result in it |
| `interrupted` | The latest bound turn was interrupted, failed, or its worker is missing |
| `done` | Closed by the worker's `result`; the outcome is shown next to it |
| `closed` | Closed by the parent without a result |

### Delegated turn binding

Each worker prompt carries the contract from `delegate`, which includes the machine token `agentbus-request: <message-id>`.

**Claude worker.** `UserPromptSubmit` and `Stop` both carry `prompt_id`, which gives exact turn identity. For a registered Claude session with an open delegation:

- `UserPromptSubmit` containing the token binds its `prompt_id` to that delegation.
- A background task completing re-invokes the session through `UserPromptSubmit` with a prompt beginning `<task-notification>`. Treat that as a continuation: its `prompt_id` stays bound. This is how a worker's own background wait delivers the parent's answer.
- Any other prompt, such as a manual Desktop follow-up, unbinds the delegation, so later turns are never attributed to the request.
- `Stop` for a bound `prompt_id` records `turn_finished`. Unless suppressed (see above), it posts a notice containing `last_assistant_message` to the parent. `Stop` also lists the session's `background_tasks`; the notice states whether any are still running, since Claude will then take another turn.
- `StopFailure` posts `turn_failed`. `PermissionRequest` posts `permission_request` as a need for user input; the hook never answers it. `SessionEnd` records `owner_released`, or posts `turn_interrupted` when a bound turn is open.

**Codex worker.** Binding is structural: a delegation is bound to the `codex exec` runs that its launcher starts, meaning the initial run and parent-initiated resumes, each carrying the token. The runner ingests `turn_started` when the run starts. When `codex exec` exits, it ingests one more event:

- `turn_finished` with the contents of `last-message.md`, when the run completed. It is subject to the same suppression rule.
- `turn_failed` with the error summary, when the run failed or produced no final message.

`codex exec` runs with `approval_policy=never`, so a Codex worker never raises `permission_request`. Turns the user starts in Codex Desktop have no runner, so they are never attributed.

In both cases a worker `result` closes the delegation; later events for that session post nothing. Tool activity is not captured; workers report progress with explicit `progress` replies.

## Storage and concurrency

Respect XDG paths:

- Config: `${XDG_CONFIG_HOME:-~/.config}/agentbus/config.json`.
- State: `${XDG_STATE_HOME:-~/.local/state}/agentbus/`.
- Database: `<state-dir>/agentbus.sqlite3`.
- Event spool and adapter logs: subdirectories of the state directory.

Use private directory and file modes (`0700` and `0600`). The state database lives on the internal disk, independent of the external volume holding the checkout. Project symlinks do not determine its location.

Tables by milestone:

| Table | Milestone | Responsibility |
| --- | --- | --- |
| `schema_migrations` | 2 | Applied migration versions |
| `sessions` | 2 | Provider identities, pending state, labels, project paths and adapter bindings; seeded with `system:observer` |
| `messages` | 2 | Immutable payloads, summaries and correlation links |
| `receipts` | 2 | Per-recipient seen and acknowledged timestamps; one row per message |
| `delegations` | 2 | Parent/worker binding, currently bound turn, open or closed state |
| `observations` | 3 | Normalized provider evidence with deterministic event IDs |
| `wake_outbox`, `wake_attempts`, `worker_leases` | 6 | Wake dispatch state, only if an adapter ships |

Delegation phase is computed by a query over messages, receipts and observations, not stored, so it cannot drift from its evidence.

Add foreign keys, uniqueness constraints and indexes for recipient inbox scans by sequence and seen state, sender retry keys, request correlation and open delegations per parent and per worker. Keep migrations transactional and serialized. `init` creates or migrates the store; other commands refuse an older or newer schema with a remediation hint, and event ingestion spools instead. A command must never silently downgrade or repair a database.

Configure every connection with `foreign_keys=ON` (SQLite applies it per connection), `journal_mode=DELETE`, `synchronous=FULL` and a busy timeout of 5 seconds for commands and 1 second for hooks. Use short write transactions; never hold one while polling, sleeping or running a subprocess. Commit a message and its delegation row, and later its wake-outbox row, in the same transaction.

`wait` polls outside transactions every 250 ms and checks `PRAGMA data_version` first, which changes only when another connection commits, so an idle wait issues no inbox queries. Both behaviors were verified under `bun:sqlite` in `DELETE` mode: `foreign_keys` defaults to 0, and `data_version` changed for the other connection but not for the committing one.

### Journal mode decision

On macOS, Bun loads the system SQLite by default: both Bun `1.3.8` and Bun `1.4.2` report SQLite `3.43.2` on this machine. Homebrew SQLite `3.53.4` is installed and loads through `Database.setCustomSQLite()`, but it would make the runtime depend on Homebrew. SQLite documents a WAL-reset race affecting concurrent connections in releases through `3.51.2`, fixed in `3.51.3` with backports including `3.44.6` and `3.50.7`. [SQLite WAL documentation](https://www.sqlite.org/wal.html#walreset), [Bun SQLite documentation](https://bun.sh/docs/runtime/sqlite).

Use rollback journal mode (`DELETE`) with `synchronous=FULL`, and offer no journal option in v1. This is a local mailbox with small, infrequent writes; correctness takes priority over throughput. If measurements later justify WAL, load a verified fixed SQLite through `Database.setCustomSQLite()` rather than trusting the system library, select the mode only in `init`, and never delete sidecar files manually. Recheck the SQLite version after the Bun upgrade.

## CLI specification

```text
agentbus init
agentbus whoami
agentbus session register|bind|list|show|update
agentbus delegate --to <claude|codex> --file <path|-> [--name <name>] [--key <key>] [--label k=v]...
agentbus delegations [<request-id|name>...] [--all] [--probe]
agentbus send <recipient> --file <path|->
agentbus reply <message-id> --file <path|->
agentbus read [--all] [--unseen] [--after <seq>] [--from <addr>] [--type <type>] [--correlation <id>] [--limit <n>]
agentbus wait [--timeout <duration>] [--settled] [--probe <interval>] [same filters as read]
agentbus ack <message-id...>
agentbus close <request-id|name>
agentbus status [<session>] [--probe]
agentbus event ingest --provider <claude|codex> --source <hook|runner> [--file <path|->]
agentbus event drain
agentbus hooks claude print|install|uninstall|status
agentbus config|cfg list|ls|path|get|set|unset|import|export
agentbus doctor|check
agentbus skill
agentbus completion <fish|zsh|bash>
```

Milestone 6 adds `send --wake`, `wake <session> --message <id>` and `worker run|list|stop` only if the Codex spike passes. Milestone 7 may add `hooks codex`. Commands not yet implemented must not appear as successful placeholders.

### Commands and flags

| Command | Inputs and behavior |
| --- | --- |
| `init` | Create the state directory and schema, or migrate forward. Idempotent. |
| `whoami` | Print the resolved caller address, its source (flag, environment or native) and registration state. |
| `session register` | Require `--provider` and either `--external-id` or `--pending`; optional `--cwd` (default: current directory), `--name` and `--label`. Return the internal ID and, once known, the provider address. |
| `session bind` | Set the native ID and adapter binding of a pending session, or confirm an existing token claim; a different existing ID is a conflict. |
| `session list/show` | Read session metadata; never probe providers. |
| `session update` | Update display metadata, labels or explicit provider binding; provider and native identity are immutable. |
| `delegate` | Caller is the parent. Create a pending worker for the provider, send the request and open the delegation in one transaction; optional `--name`, `--cwd`, `--key`, `--summary` and `--label`. Return `workerId`, `requestId`, `returnPath` and `contract`, the worker instructions for that provider; `--contract-out <path>` also writes it to a file. Retrying with the same `--key` returns the same IDs. |
| `delegations` | Caller's delegations as a parent: worker name, provider, labels, phase, outcome, latest summary, age and pending question. Default: open ones plus those closed in the last 24 hours; `--all` for history. Targets show one delegation in detail. `--probe` adds live activity, plus Claude job `detail` and `needs` read from `~/.claude/jobs/<short-id>/state.json`. |
| `send` | Require `--file`; optional `--type`, `--key`, `--summary` and `--outcome`. Default type `message`. A `request` opens a delegation. |
| `reply` | Same body, summary, type and retry flags as `send`; derive destination and correlation. |
| `read` | Default: caller's unacknowledged inbox in ascending sequence, limit 50; changes nothing. `--unseen` returns only unseen messages and marks them seen. `--all` includes acknowledged history. Filters combine. Returns `cursor`. |
| `wait` | Return unseen matching messages as soon as any exist and mark them seen; otherwise poll until the timeout. `--settled` instead returns when none of the caller's delegations is `pending`, `working` or `permission`, with the delegation table. `--probe <interval>` runs the liveness probe for the caller's open delegations at that interval. Never acknowledges. |
| `ack` | Mark the caller's selected messages accepted; repeated acknowledgement is a success. |
| `close` | Parent closes an open delegation without a result, for an abandoned, lost or removed worker. |
| `status` | Mailbox counts and spool backlog; with a session, its latest observations. `--probe` adds live Claude activity and owner from `claude agents --all --json`; without it, no provider subprocess runs. |
| `event ingest` | Entry point for Claude hooks (`--source hook`, payload on stdin) and the Codex runner (`--source runner`, normalized event file). See Provider adapters. |
| `event drain` | Ingest spooled events. `read`, `wait`, `delegations` and `status` also drain before reading. |
| `hooks claude` | `print` emits the settings snippet. `install` merges it into `~/.claude/settings.json` idempotently, preserves existing hook entries and writes a backup; supports `--dry-run`. `status` verifies the entries. Only this explicit command changes provider settings. |
| `config` | Support non-interactive setup, batched set/get/unset, stdin JSON import and JSON export. |
| `doctor` | Read-only readiness checks with remediation, including hook installation, spool backlog and schema version; never start a daemon, log in, drain the spool or rewrite provider settings. |
| `skill` | Print the real repository skill installation URL after the repository exists; fail clearly while its URL is unconfigured. |
| `completion` | Print the completion script to stdout; installation remains explicit. |

Global options: `--as`, `--config`, `--state-dir`, `--json`, `--plain`, `-q/--quiet`, `-v/--verbose`, `--no-color`, `--no-input`, `-h/--help` and `--version`. `--json` and `--plain` are mutually exclusive; quiet mode must not suppress requested machine receipts. Help and version require neither initialization nor provider access.

Accept positive durations with `ms`, `s`, `m` or `h`. `wait` defaults to 60 seconds and accepts at most 24 hours. Short waits let an agent report between checks; long waits let a Claude background command re-invoke its session when a message arrives. `--probe` intervals are at least 10 seconds. Provider subprocess timeouts are separate from wait timeouts. Limits default to 50 and cap at 1,000 records.

All body input comes from a file or `--file -`; do not put handoff packets in argv. Call provider binaries with argument arrays, never generated shell command strings. `--dry-run` on `delegate`, `send`, `reply` and `hooks claude install` validates and describes the action without writing.

### Worker contract

`delegate` generates the worker instructions, so all launchers append identical text for a given worker provider. The contract states:

- The worker's address and the request token. For Claude workers, every command uses `--as <worker-id>`; Codex workers get `AGENTBUS_SESSION_ID` from the runner.
- Read the request, acknowledge it, and optionally send `progress` replies at real milestones only.
- On a decision or blocker, send `reply --type question --summary ...` to the parent instead of asking the user, then:
  - Claude worker: arm `agentbus wait --correlation <request-id> --timeout 12h` as a background command and end the turn.
  - Codex worker: wait in-turn with bounded `wait` calls, or end the turn.
- On finishing, send `reply --type result --outcome <success|blocked|failed> --summary ...`. The body holds the result, verification performed and anything the parent must still decide.
- Do not message the parent through provider-native channels; the mailbox is the record.

Launchers append their own extra rules after it. For example, `claude-threads` adds its worktree-isolation refusal rule. Contract text is versioned with the CLI; `delegate --dry-run` prints it for review.

### Output and exit codes

Human output is concise, with payload text only on commands intended to read it. `--plain` returns stable tab-separated fields. `--json` produces one versioned object per invocation, including failures; logs and diagnostics remain on stderr.

Example `delegate` receipt:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "data": {
    "workerId": "<uuid>",
    "requestId": "<uuid>",
    "sequence": 42,
    "duplicate": false,
    "delegation": { "phase": "pending" },
    "returnPath": "background_wait",
    "contract": "…"
  }
}
```

`returnPath` tells the parent how replies will reach it, derived from the parent's provider: `heartbeat` for Codex (until a verified adapter covers the binding, then `adapter`), `background_wait` for Claude. The parent skill acts on it instead of guessing. A plain `send` of a non-request has `delegation: null`.

Errors use `{schemaVersion, ok: false, error: {code, message, exitCode, details}}`. Details contain IDs and remediation, not routine payload dumps. Provider acceptance is reported as `accepted`, never `read`.

| Exit | Meaning |
| --- | --- |
| `0` | Operation succeeded; mailbox persistence is sufficient for `send` |
| `1` | Unexpected failure, or failing readiness checks |
| `2` | Invalid usage or invalid input |
| `3` | Wait timed out; return an empty message list with `timedOut: true` |
| `4` | Session, message or configured resource not found |
| `5` | Conflicting retry key, ambiguous identity or incompatible ownership |
| `6` | Database contention exhausted its deadline |
| `7` | Reserved for milestone 6: explicit wake unsupported, unavailable, failed or uncertain |
| `130` | Interrupted by Ctrl-C |

### Configuration

Precedence: explicit flags, `AGENTBUS_*` environment values, selected user config, defaults. V1 has no automatically discovered project configuration. Never repurpose `HOME` or `CODEX_HOME`.

Environment variables are `AGENTBUS_SESSION_ID`, `AGENTBUS_CONFIG` and `AGENTBUS_STATE_DIR`, plus standard XDG and color variables. Native provider session variables are read only for caller resolution. Reject unknown configuration keys and report the resolved paths.

Store provider executable paths in config; add wake strategy names in milestone 6. Backend bindings belong to session records, not a global current-project setting. Credentials are unnecessary for the same-user local MVP; any later secret settings must accept stdin or a credential reference and redact normal listings.

## Provider adapters

### Claude hooks

Install hooks in user settings (`~/.claude/settings.json`), which already contains the user's own hooks, so CLI background sessions and Desktop-resumed sessions load the same entries. Do not rely on `--settings` passed only to the initial process. Milestone 3 verifies both owners.

Subscribe only to low-frequency events: `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Stop`, `StopFailure` and `SessionEnd`. Skip tool-use and `SubagentStop` events: user hooks run in every Claude session on the machine, including unrelated ones, and progress belongs in explicit replies.

Hook command contract:

- Guard the command so a missing binary is a silent no-op. The `bun link` target lives on an external volume and disappears when it is unmounted. The command always exits 0; exit code 2 would block Claude, and on `Stop` would keep the turn running.
- Print nothing to stdout. Output from `UserPromptSubmit` and `SessionStart` becomes model context, and JSON output can return permission or stop decisions.
- For an unregistered `session_id`, perform one indexed lookup and exit without writing anything. The exception is a `UserPromptSubmit` whose prompt contains a request token, which may claim a pending session. The token check is an in-memory string match, done before any database access. A cold Bun start plus a read-only SQLite lookup measured 10–20 ms; target under 50 ms.
- For a registered session, commit the observation and any notice in one transaction within the hook budget.
- If the commit cannot complete (store busy, missing or on another schema), write the normalized event to `<state-dir>/spool/` using a temp file and atomic rename. The spool file keeps the event ID, so re-ingestion is idempotent. Drain removes a file only after its commit and ignores incomplete temp files.

`Stop.last_assistant_message` supplies the fallback final response. `Stop` can coexist with active background tasks, and API failures use `StopFailure`; handlers preserve those distinctions. [Claude hooks reference](https://code.claude.com/docs/en/hooks#stop). Explicit `result` replies take precedence over fallback text. Reading persisted conversation history through the Agent SDK's `get_session_messages()` remains an optional later feature. [Anthropic session browser example](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser).

Optional in milestone 3: for a registered session with pending mail, `SessionStart` and `UserPromptSubmit` add one line of context listing counts and message IDs, never bodies. This is the only permitted hook output.

### Claude session probing and Desktop handoff

`claude agents --all --json` rows expose at least `id`, `sessionId`, `kind`, `state`, `name`, `cwd` and `startedAt`; live rows add `pid` and `status`, which the launcher's `desktop.sh` uses. The short `id` is the first 8 characters of `sessionId`. Observed states include `working`, `done` and `stopped`. `~/.claude/jobs/<short-id>/state.json` adds `detail` and `needs`, which `claude-threads` shows today. Probes read both files and never write them. Validate rows with Zod, match the exact `sessionId`, and treat absent fields or rows as unknown; a failed `claude agents` call is never read as "missing".

The `codex-to-claude` Desktop helper polls every 5 seconds, waits for `state=done` and an idle status, stops the background owner and opens the same session through `claude://resume`. It remains the only handoff controller. Agentbus needs no handoff logic: user-level hooks keep firing after the transfer and are filtered by UUID, and probes report the observed owner. `claude-threads` imports children into the Desktop sidebar while the background process keeps owning them; that does not affect Agentbus.

**Existing launcher defect.** After any turn in which a background command ran, `state` stays `working` with `status: idle` indefinitely. A control session without background commands reached `done`. The helper's `state=done` condition therefore stalls for its full 24-hour deadline whenever the delegated work used a background command, and an armed Agentbus wait always is one. Milestone 4 fixes the helper: treat the session as ready for handoff when `status` is idle and the latest `Stop` observation reports no running `background_tasks`, not when `state` is `done`.

### Codex runner events

`claude-to-codex` already starts a detached runner that owns one `codex exec --json` run, names the thread afterwards and writes `state.json` and `last-message.md`. Milestone 4 extends it without changing its ownership rules:

1. Before starting `codex exec`, set `AGENTBUS_SESSION_ID=<worker-id>` and remove `CLAUDE_CODE_SESSION_ID` from the child environment.
2. On `thread.started`, run `agentbus session bind <worker-id> --external-id <thread_id>` with the run directory and runner PID, then ingest `turn_started`. A resume run keeps the bound thread ID, updates the PID and ingests `turn_started`.
3. After `codex exec` exits and `state.json` is final, write a normalized event file and run `agentbus event ingest --provider codex --source runner --file <event>`. The event holds the thread ID, the run's turn ID when available, `completed` or `failed`, the final message and an error summary.
4. Agentbus failures never change the runner's own outcome: a failed ingest spools, and the runner still writes `state.json`.

The runner is the authoritative observer while `codex exec` owns the thread, which is the tracking scope chosen for v1. Codex also supports Claude-compatible hooks: under `codex exec` they report `session_id` (the thread ID), `turn_id`, `prompt` and `last_assistant_message`. But non-managed hooks run only after the user trusts their exact hash in `/hooks`, so hooks are not required for v1. They are optional in milestone 7, for best-effort coverage of turns in Codex Desktop. [Codex hooks reference](https://developers.openai.com/codex/hooks).

### Return paths

**Claude parent: background wait.** After delegating, the parent skill arms one wait as a Claude Code background command and ends its turn:

```bash
agentbus wait --timeout 30m --probe 60s
```

Without filters it covers every delegation of the parent, including workers delegated after it was armed, so a lead with several children needs exactly one watcher. Claude Code re-invokes the session when the wait exits; this was verified in a `--bg` session, where a background `sleep 25` produced a `<task-notification>` prompt and a new turn. On re-invocation the parent:

- On messages: runs `read`, acts on them, acknowledges them, and re-arms the same command. Seen state makes re-arming cursor-free.
- On a timeout (exit 3): checks `delegations`, reports only real changes, and re-arms. With `--probe`, crashed workers surface as `turn_interrupted` notices before the timeout; the timeout bounds idle re-invocations.
- For a batch: `agentbus wait --settled` returns once no delegation is pending, working or waiting for permission.

A background wait dies with its owning process. A Claude parent that is itself a background worker (for example Codex→Claude→Codex) keeps its session busy while the wait is armed, so its own Desktop handoff waits until the nested delegation finishes. That is intended, per the fixed readiness rule.

**Codex parent: heartbeat.** The parent skill creates a heartbeat on the original chat through the app's automation tool after delegating. Its prompt is static, which seen state makes sufficient: each wake runs `agentbus wait --correlation <request-id> --timeout 1s`. It reports only meaningful changes (a question, a result or a blocking notice) and acknowledges what it handled. The skill deletes the heartbeat after acknowledging the delegation's `result` or closing it. The CLI cannot invoke that app-only tool itself. [Thread automation behavior](https://learn.chatgpt.com/docs/changelog). Automatic wake-up of a Codex parent is milestone 6.

### Follow-ups to workers

A follow-up is always first written to the mailbox (`reply` to the worker's question), so the durable record exists before any delivery attempt.

**Claude worker.** The contract makes the worker arm its own background wait after asking, so the parent's `reply` re-invokes it as a `<task-notification>` continuation of the bound turn. This works for any parent provider, so Claude→Claude needs no `SendMessage`. A Claude lead may still send a `SendMessage` as an extra doorbell, but the protocol never depends on it. Whether a wait armed in a Desktop-owned session behaves the same is a milestone 3 check. Resuming a stopped Claude session can be added only after verifying that no live owner exists and keeping the returned native ID: the CLI can copy a conversation resumed while a live owner remains, and silent copies are unacceptable. A local MCP Channel is the later route for pushing into a running session. [Claude Channels reference](https://code.claude.com/docs/en/channels-reference).

**Codex worker.** Within a run, the worker may call bounded `wait` before ending its turn. Once the run has ended with a question, the Claude parent delivers the answer by resuming the same thread through the launcher: `spawn.sh --resume <threadId> -f followup.md`. `followup.md` carries the token, the worker address and the answer's message ID. Preconditions:

- The runner state is `completed` or `failed`, never `running`.
- Desktop has not been asked to open the thread (`desktopOpenRequested: false`). If the user may have opened the `desktopLink`, the parent asks the user before resuming, because Desktop keeps its own copy and the histories would diverge.

The resumed run must report the same `threadId`; a different ID is a fork, and the parent reports it instead of continuing. Agentbus never resumes on its own in v1.

### Codex wake adapter (milestone 6)

This concerns waking a Codex **parent** chat without a heartbeat. The installed CLI `0.157.1` exposes `codex queue --thread <id> --message <text>` with an optional `--remote <addr>` app-server endpoint (`ws://`, `wss://` or `unix://PATH`). `codex agents` browses sessions on a "shared local app-server daemon", and `codex remote-control start|stop|pair` manages that daemon. The standard daemon endpoint returned `Connection refused` when checked. This establishes an interface candidate, not working delivery into the current Desktop chat. Run a bounded spike against a disposable Codex chat to establish:

1. Which backend owns the chat and whether the CLI can address that same backend.
2. Behavior when the chat is working, idle and not displayed.
3. Whether acceptance starts or queues a turn, and how to verify that without creating a fork.
4. Behavior after disconnect/reconnect, unknown receipt and repeated dispatch.
5. Whether a Codex background terminal re-invokes the chat when it exits, equivalent to the Claude background-wait pattern; that would avoid a worker entirely.

If the spike passes, send a small notice containing the message ID and instructions to read the mailbox; keep the body in the store. Do not start a second daemon as a guessed workaround for an inaccessible Desktop backend. An App Server adapter is another candidate where the owning backend offers a supported connection; `turn/start` and `turn/steer` have different lifecycle behavior, so do not guess which one is safe for an existing turn. [Codex App Server reference](https://learn.chatgpt.com/docs/app-server).

Use database leases with a random owner token and increasing fencing generation. Proposed defaults: renew every 10 seconds, expire after 30 seconds and bound each provider command to 10 seconds; verify them under machine sleep and resume. Recheck the lease before dispatch and before committing a receipt. A stale worker that wakes after its lease expired exits without changing the new owner's state. Never hold a transaction across a provider operation.

Wake states are `pending`, `dispatching`, `accepted`, `unsupported`, `failed` and `uncertain`. Retry only failures known to occur before provider acceptance. If the process dies after dispatch and before saving the receipt, mark the attempt uncertain unless the provider supplies an idempotency mechanism or verifiable receipt. Never automatically repeat an ambiguous model-start operation. Request a wake only for attention events: `result`, `question`, and `turn_failed`, `turn_interrupted` or `permission_request` notices.

## `claude-threads` on Agentbus

`claude-threads` (in `agent-skills`) makes a Claude session the lead of background Claude children. Today it implements its own tracking in `threads.py` (673 lines):

- A per-lead registry of `meta.json` files.
- A `report.md` contract with a parsed `Status:` line.
- A watcher that polls `claude agents` and `~/.claude/jobs/*/state.json`.
- Heuristics that second-guess model-classified states.
- Transcript parsing to detect whether a child already messaged its lead.
- Lead addressing through the ListAgents name or a `uds:` socket, which break on rename or app restart.

Agentbus covers all of it, so the skill keeps only what is genuinely about launching:

| `claude-threads` today | On Agentbus |
| --- | --- |
| `threads.py prepare/register/discard`, registry directory, `meta.json` | `agentbus delegate` (with `--label model=… effort=… worktree=…`), then `session bind` |
| Thread contract constant, `report.md`, `--add-dir` for the report directory | Contract from `delegate` plus the skill's isolation rule; `result` with outcome and summary |
| Lead ListAgents name or `uds:` socket; `SendMessage` from child to lead | Durable parent address; `reply` from child to lead |
| `wait.sh`: polling, `seen` fingerprints, `pushed_at`/`push_covers` | `agentbus wait --timeout 30m --probe 60s`; seen state and notice suppression |
| `wait.sh --all` | `agentbus wait --settled` |
| `lifecycle()` over model-classified `state`/`tempo` | Delegation phase derived from messages and hook observations |
| `status.sh` table | `agentbus delegations` (`--probe` adds `detail`/`needs`) |
| Lead answers with `SendMessage` | `agentbus reply`; the child's own background wait wakes it |
| `cleanup.sh stop/rm` | Kept: a small script that resolves children through `delegations --json`, runs `claude stop`/`rm`, and closes delegations of removed children |

`spawn.sh` keeps model, effort, permission mode, worktree, the `bgIsolation` preflight, `-a` shared prompt sections, naming, `claude --bg`, Desktop import and Ghostty attach. Untracked spawning (`--no-track`) stays free of any Agentbus dependency; tracked spawning requires Agentbus and checks `agentbus doctor` first.

Expected result: `threads.py` is deleted, `wait.sh` and `status.sh` become one-line wrappers or disappear in favor of the commands themselves, and the skill's lifecycle table is replaced by the delegation phase table. The remaining scripts shrink from about 980 to about 300 lines. Children already in flight under the old registry are finished or stopped before switching; there is no registry migration.

## Example agent workflows

Commands below illustrate the intended interface. Replace placeholders with real IDs and existing paths.

### Codex parent, Claude worker

```bash
agentbus init --json

# Codex parent, through codex-to-claude; caller resolves from CODEX_THREAD_ID
agentbus session register --provider codex --external-id "$CODEX_THREAD_ID" --name planner --json
agentbus delegate --to claude --name implementer --cwd /Users/example/dev/project \
  --key task-001 --file "$handoff_dir/request.md" --json   # -> workerId, requestId, returnPath: heartbeat, contract
# spawn.sh appends the contract, starts claude --bg, then confirms the token claim:
agentbus session bind <worker-id> --external-id <claude-session-uuid> --json

# Claude worker; every command uses --as from its contract
agentbus --as <worker-id> read --type request --json
agentbus --as <worker-id> ack <request-id> --json
agentbus --as <worker-id> reply <request-id> --type result --outcome success \
  --summary "Implemented parser fix; tests pass" --key task-001-result \
  --file "$handoff_dir/result.md" --json

# Codex heartbeat wake (static prompt)
agentbus wait --correlation <request-id> --timeout 1s --json
agentbus ack <result-message-id> --json
```

### Claude parent, Codex worker

```bash
# Claude parent in a Desktop session, through claude-to-codex; caller resolves from CLAUDE_CODE_SESSION_ID
agentbus session register --provider claude --external-id "$CLAUDE_CODE_SESSION_ID" --name lead --json
agentbus delegate --to codex --name executor --cwd /Users/example/dev/project \
  --key task-002 --file "$run_dir/request.md" --json       # -> returnPath: background_wait
# the runner sets AGENTBUS_SESSION_ID=<worker-id>, binds on thread.started, reports turn events

# Claude parent arms the wait as a background command, then ends its turn
agentbus wait --timeout 30m --probe 60s --json

# Codex worker; caller resolves from AGENTBUS_SESSION_ID
agentbus ack <request-id> --json
agentbus reply <request-id> --type question --summary "Which config wins?" --file - --json <<'EOF'
Both config.json and config.local.json define `port`. Which one should win?
EOF

# Claude parent, re-invoked by the wait: answer, resume the same thread, re-arm
agentbus reply <question-id> --file "$run_dir/answer.md" --json   # -> <answer-id>
~/.claude/skills/claude-to-codex/scripts/spawn.sh --resume <thread-id> \
  -f "$run_dir/followup.md" -C /Users/example/dev/project           # followup names <answer-id>
agentbus wait --timeout 30m --probe 60s --json
```

### Claude lead, Claude children (`claude-threads`)

```bash
S=~/.agents/skills/claude-threads/scripts
$S/spawn.sh -f review-api.md -n "Review API layer" -m sonnet -e high -C ~/dev/app --mode auto
$S/spawn.sh -f review-ui.md -n "Review UI layer" -m sonnet -e high -C ~/dev/app --mode auto
# each spawn runs agentbus delegate --to claude --label model=sonnet --label effort=high …

agentbus wait --timeout 30m --probe 60s --json      # run_in_background, once for the whole batch
agentbus delegations
# NAME              PROVIDER  LABELS              PHASE     AGE  SUMMARY
# Review API layer  claude    model=sonnet,high   question   4m  Keep v1 routes or drop them?
# Review UI layer   claude    model=sonnet,high   working    4m  -

agentbus reply <question-id> --summary "Drop v1 routes" --file - <<'EOF'
Drop the v1 routes; keep the redirects.
EOF
# the child's own background wait re-invokes it; the lead re-arms its wait
```

The same packet file serves as the prompt and the request body; the mailbox copy is the durable record. `--file -` also accepts piped text. An answer uses `reply` on the question, preserving correlation. The worker's acknowledgement and final result are separate messages and receipts, so a stopped worker does not erase evidence of outstanding work.

## Repository structure

```text
bin/agentbus
src/index.ts
src/cli/program.ts
src/cli/commands/
src/config/
src/protocol/            # envelope, contract templates
src/store/migrations/
src/store/
src/services/            # delegations, phases, notices
src/adapters/claude/     # hooks, agents and job-state probe
src/adapters/codex/      # runner events, runner probe; milestone 6 wake
src/worker/              # milestone 6
tests/integration/
tests/e2e/
scripts/
skill/agentbus/SKILL.md
README.md
PLAN.md
package.json
tsconfig.json
bun.lock
```

Commands orchestrate domain operations; SQL belongs to store modules, provider subprocesses to adapters, and workflow state to services. Start with concrete functions and types; extract shared adapter interfaces only when both providers need them. Normalized observation events and the probe result are the first shared contracts. Keep code files below roughly 1,000 lines.

Use a Bun entrypoint, package `bin` mapping, strict TypeScript and current compatible dependency releases locked at scaffolding time. Add lint/format tooling then and check its maintenance before introducing it. Recheck Commander, Zod and Picocolors versions when implementation starts. [Commander](https://github.com/tj/commander.js), [Zod](https://github.com/colinhacks/zod), [Picocolors](https://github.com/alexeyraspopov/picocolors).

### Bun version policy

Resolve the latest stable Bun from the official release feed when implementation begins; do not use canary or treat the older local binary (`1.3.8`) as the baseline. The stable release on September 30, 2026 is `1.4.2`; re-resolve at scaffolding time. [Official Bun release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2).

Update Bun through its existing installation method, then record `bun --version` and `bun --revision`. Pin that version in `packageManager` and CI, set the supported floor in `engines.bun`, and document it in README. Verify the SQLite version separately after the runtime change.

## Implementation milestones

### 1. Scaffold and contracts

- Select the latest stable Bun; record its version, revision and SQLite version.
- Initialize the Bun project; create the binary, strict compiler config, lint setup and command registration.
- Define message, session, observation, phase, output and error schemas; document exit codes and proposed defaults.
- Implement help/version, configuration, read-only diagnostics, `whoami` and completion output.
- Capture provider evidence as fixtures:
  - Claude: `claude --help`, `claude agents --all --json` rows (including a `working`/`idle` row left behind by a background command) and `~/.claude/jobs/<id>/state.json` samples.
  - Claude: payloads for the six subscribed hook events, including a `<task-notification>` prompt, a `Stop` with running `background_tasks`, a `PermissionRequest` and a `SessionEnd` during an open turn.
  - Codex: `codex exec --json` event streams for success, failure and resume, the runner's `state.json`, and `codex queue --help`.
- Verify the binary from a temporary working directory with no initialized mailbox; help must still work.

Exit condition: CLI conventions, configuration and validation are usable; diagnostics identify missing state and provider capabilities without changing them.

### 2. Durable mailbox

- Implement migrations, sessions with pending state, labels and the `system:observer` seed, messages with summaries, receipts and delegations.
- Implement send/reply/read/wait/ack/close/bind and `delegate` with contract generation, retry-key conflicts, seen state, cursors, `wait --settled`, `returnPath` and dry-run behavior.
- Implement `delegations` with phases derivable from messages alone; observation-based phases arrive in milestone 3.
- Commit before printing receipts; handle busy deadlines and Ctrl-C.
- Verify separate OS processes, Unicode bodies, long stdin input, concurrent senders, restart recovery and recipient-scoped acknowledgements.

Exit condition: the mailbox satisfies acceptance criteria 1–4 with provider adapters disabled.

### 3. Worker result capture

- Run the remaining Claude checks first, with disposable sessions:
  - The UUID and `prompt_id` continuity survive Desktop resume.
  - User-level hooks (not `--settings`) fire under both owners.
  - A background wait armed in a Desktop-owned session re-invokes it.
  - `SessionEnd` fires on `claude stop` of a working session.
- Implement `event ingest` for both sources, deterministic event IDs, token claims, the spool and drain, observations, turn binding, notices with suppression and interruption, and observation-based phases.
- Implement `hooks claude print|install|uninstall|status`.
- Implement the probes: Claude via `claude agents` and job state, Codex via the runner PID from the adapter binding. Expose them through `status --probe`, `delegations --probe` and `wait --probe`.
- Drive `--source runner` with recorded `codex exec` fixtures through the public CLI; the live runner integration lands in milestone 4.

Exit condition: acceptance criteria 5–8 and 11 at the adapter level. Claude turn completion, failures, interruptions and permission prompts reach the parent's inbox with no Agentbus process besides the hook; Codex runner events produce the same notice kinds; outcome remains unknown when only final text exists.

### 4. End-to-end delegation between providers (first release)

- Write the consumer skill under `skill/agentbus/SKILL.md`: identity, message types, seen state, acknowledgements, outcomes, the parent loop per `returnPath`, the worker role, the question round-trip and recovery.
- Integrate `codex-to-claude`: `delegate`, contract, post-launch `session bind`, and `reply --type result` in place of the ad hoc `result.md` handshake. Fix its handoff readiness rule (idle status and no running background tasks, not `state=done`). Preserve its Desktop ownership rules; its helper remains the only handoff controller.
- Integrate `claude-to-codex`: `delegate`, contract, runner environment (`AGENTBUS_SESSION_ID`, removal of `CLAUDE_CODE_SESSION_ID`), bind on `thread.started`, and runner event ingestion. Resume keeps the thread ID and refuses to run when the run is active or Desktop may own the thread. `last-message.md` stays as the runner's local record.
- Document both parent lifecycles: the Codex heartbeat with its static prompt, and the Claude background wait with `--probe` and timeout re-arm.
- Add README installation, doctor/config/hooks examples, protocol contract and a provider support matrix per role.
- Run the full gate, then `bun link`; verify the installed command outside the checkout.

Exit condition: acceptance criteria 9 and 10 with two disposable end-to-end runs, each without a duplicate conversation or competing file edits:

- Codex→Claude: the result returns to the original Codex chat through a heartbeat after that chat's first turn ended.
- Claude→Codex: the parent is re-invoked by its wait, answers one worker question by resuming the same thread ID, and then receives the result.

### 5. `claude-threads` on Agentbus (Claude→Claude)

- Replace the tracked path of `spawn.sh` with `delegate` (name, labels, contract) and `session bind`. Append the skill's isolation rule after the contract, and drop `--add-dir`, `--lead` and lead-name resolution.
- Replace `wait.sh` and `status.sh` with `agentbus wait --timeout 30m --probe 60s` (`--settled` for batches) and `agentbus delegations`.
- Rewrite `cleanup.sh` around `delegations --json`; `rm` also closes the delegation. Delete `threads.py`.
- Rewrite `SKILL.md`: the phase table replaces the lifecycle table, `report.md` and `SendMessage` leave the contract, and Verified Facts that no longer apply are removed.
- Verify with disposable children:
  - Two children, one asking a question, one hitting a permission prompt, and one killed with `kill -9`.
  - A child spawned after the watcher was armed.
  - No second wake after a question.
  - The phase table matches each child.
  - Answering a question re-invokes the child through its own background wait.

Exit condition: acceptance criteria 13–14; the skill's scripts no longer read `claude agents`, job state or transcripts except through `agentbus --probe`.

### 6. Codex wake adapter (conditional)

- Run the backend capability spike before writing production dispatch.
- If it passes, implement the wake outbox, attempt receipts, leases with fencing, uncertain-dispatch handling, `send --wake`, `wake`, `worker run|list|stop` and exit code 7.
- Verify active/idle chats, unavailable adapters, duplicate notices, interrupted dispatch and restart recovery.

Exit condition: acceptance criteria 15–16. If the spike fails, record the evidence, keep the heartbeat as the supported Codex return path and do not ship a worker.

### 7. Optional extensions

- `hooks codex print|install|status` for `~/.codex/hooks.json`, with a documented one-time `/hooks` trust step, for best-effort observation of Codex Desktop turns. It deduplicates against runner events by turn ID.
- Prototype a local Claude MCP Channel with request/reply correlation; verify running-session delivery and channel loading after Desktop transfer.
- Add transcript inspection through SDK read APIs if mailbox notices are insufficient.
- Consider supervised launchd installation only after worker restart behavior is verified and persistent monitoring is requested.

This milestone is outside the release acceptance gates.

## Verification and release gate

Use real subprocesses and temporary state directories for mailbox integration checks. Hook fixtures, runner fixtures and fake provider executables enter through the public CLI/process boundary. Do not add unit-test targets or tests that merely mirror helper implementation.

| Scenario | Required evidence |
| --- | --- |
| Concurrent writers/readers | Committed record count, unique IDs, no missing acknowledged records, database integrity check |
| Retry collisions | Same keyed payload returns the same ID; changed payload is rejected; `delegate` retry returns the same worker and request |
| Interrupted wait | Exit 130; pending messages remain retrievable |
| Seen state | `wait` returns each message once; `read` still lists it until acknowledged; lost wait output is recoverable through `read` |
| Settled wait | `wait --settled` returns only when no delegation is pending, working or waiting for permission |
| Process crash after commit | Reopened mailbox contains the committed message |
| Receipt emitted | Corresponding transaction is already committed |
| Wrong recipient | Reading, replying, acknowledging and closing fail without modifying state |
| Authorship | A `notice` from a non-system sender, an `outcome` on a non-result and a reply to a notice are rejected |
| Impersonation | A worker using its parent's identity cannot acknowledge or reply to its own request |
| Cursor recovery | Pagination has stable order; advancing a cursor does not erase unacknowledged messages |
| Unregistered hook | Exit 0, empty stdout, no database or spool writes; latency recorded |
| Missing binary | Guarded hook command is a silent no-op with the checkout volume unavailable |
| Spool interruption | Complete spool event survives restart and ingests once; incomplete temp file is not ingested |
| Duplicate event | The same turn reported twice ingests once |
| Notice suppression | A turn containing a `question` or `result` posts no `turn_finished` notice; a turn with only `progress` does |
| Interruption | `claude stop` mid-turn posts `turn_interrupted`; `kill -9` is caught by `wait --probe`; a failed probe call is not read as missing |
| Turn binding | A tokenless follow-up turn produces no notice for the earlier request; a `<task-notification>` turn stays bound |
| Token claim | Only a prompt with the exact token claims a pending session; a conflicting `session bind` is rejected |
| Owner release | `SessionEnd` from `claude stop` of an idle session or a `codex exec` exit leaves the delegation open |
| Phases | `delegations` phases match the recorded event sequence for each fixture |
| Worker final response | Explicit `result` and observer `turn_finished` notice remain distinguishable for both providers |
| Desktop ownership change (Claude) | Same native UUID; hooks still fire; unrelated subsequent turns are not attributed |
| Runner outcomes (Codex) | Completed run → `turn_finished` with the final message; failed run → `turn_failed`; dead runner → `turn_interrupted` through the probe |
| Codex worker identity | Worker resolves to its internal ID despite the parent's leaked `CLAUDE_CODE_SESSION_ID` |
| Codex resume | Same thread ID after resume; refused while running or after `desktopOpenRequested` |
| Claude parent wake | One background wait re-invokes the parent for any delegation, including one created after arming; a timeout re-arms without user-visible noise |
| Claude worker follow-up | A parent `reply` re-invokes a Claude worker through its own background wait as a bound continuation |
| No Codex wake strategy | Message remains stored; receipt reports `returnPath: heartbeat` |
| File/stdin input | Quotes, shell syntax, Cyrillic and long text arrive unchanged |
| Help/doctor | No model launch, login, provider config change, spool drain or daemon bootstrap |
| Worker competition (milestone 6) | One lease owner; a stale fenced owner cannot commit receipts |
| Unknown dispatch (milestone 6) | Attempt becomes uncertain; no automatic second model-start request |

The package gate is `bun run lint`, `bun run typecheck`, `bun run test:integration`, `bun run test:e2e`, plus a documented installed-command smoke check. Create these targets during scaffolding. Tests isolate their state and clean up only resources they created. Tests never touch the real `~/.claude/settings.json` or `~/.codex` configuration.

Use disposable provider sessions for live adapter checks. Collect the native IDs, backend binding, command receipts and observed result. Do not stop or resume unrelated existing sessions to make a check pass; archive only Codex test threads created by the check. Report missing provider capabilities as incomplete acceptance criteria rather than a successful mocked end-to-end result.

## Remaining implementation questions

None block the mailbox milestone. Each has a narrow check in the milestone noted:

- Do the session UUID, user-level hooks and `prompt_id` behave the same after Claude Desktop resume? (3)
- Does a background wait armed in a Desktop-owned Claude session re-invoke it? (3)
- Does `SessionEnd` fire when a working Claude session is stopped mid-turn, and what does `claude agents` show after `kill -9`? (3)
- Does the `codex exec --json` stream expose a turn ID the runner can report, for deduplication with optional Codex hooks? (1)
- Does `codex exec resume` from the runner keep the thread ID and pass the new environment to tool shells? (4)
- Is `CODEX_THREAD_ID` set in Codex Desktop tool shells, as it is under `codex exec`? (4)
- Can `codex queue`, through the shared app-server daemon or `--remote`, reach the backend that owns the Desktop chat, and what receipt does it expose? (6)

Resolved by design: turn identity uses the prompt token plus native turn IDs, Claude hooks live in user settings, Codex workers are observed by their runner, re-arming uses seen state instead of cursors, and the default journal mode is rollback.

## Pre-implementation evidence

Checked on 2026-09-30 with Claude Code 2.1.284, Codex CLI 0.157.1 and disposable sessions, since stopped:

| Check | Result | Plan impact |
| --- | --- | --- |
| `claude --bg --session-id <uuid>` | Flag ignored; Claude assigned its own UUID | Token-claimed pending sessions replace preassignment |
| Launcher environment into `claude --bg` | Not inherited by hooks or the Bash tool | Claude worker identity via explicit `--as` |
| `CLAUDE_CODE_SESSION_ID` | Set in Desktop tool shells and in hook environment; absent in `--bg` Bash tool | Native detection is a convenience only |
| `CODEX_THREAD_ID` under `codex exec` | Equals the thread ID; the launcher's environment is inherited, including a test variable and the parent's `CLAUDE_CODE_SESSION_ID` | Runner sets `AGENTBUS_SESSION_ID` and removes the leaked variable; ambiguity refusal confirmed |
| Claude hook payloads | `prompt_id` on `UserPromptSubmit` and `Stop`; `Stop` has `last_assistant_message`, `background_tasks`, `session_crons`; `SessionStart` has `source` | Exact turn binding; notices report running background work |
| Background command in `--bg` session | Re-invoked the session via a `<task-notification>` prompt | Claude parent wake and Claude worker follow-ups without Channels or `SendMessage` |
| `claude agents` after a background-command turn | `state: working`, `status: idle` for over five minutes; control session reached `done` | Launcher helper stalls; readiness rule fixed in milestone 4; phases do not use provider state |
| `claude stop` | Fires `SessionEnd` with `reason: other` | Owner release never closes a delegation |
| Codex hooks under `codex exec` (via `-c` overrides and `--dangerously-bypass-hook-trust`) | `SessionStart`, `UserPromptSubmit` (`turn_id`, `prompt`), `Stop` (`turn_id`, `last_assistant_message`) and `SessionEnd` at exec exit; `session_id` is the thread ID; no `CODEX_THREAD_ID` in hook environment; empty stdout accepted | Codex hooks are viable later; `SessionEnd` means process exit |
| Codex hook trust | Non-managed hooks need `/hooks` trust by exact hash; project hooks load only in trusted projects | Runner events, not hooks, are the v1 Codex observer |
| Bun `1.4.2` (latest stable, 2026-09-05) | System SQLite `3.43.2`, same as `1.3.8`; Homebrew `3.53.4` loads via `setCustomSQLite` | Rollback journal stays |
| `foreign_keys`, `data_version` | Default 0; changes only for other connections' commits | Per-connection pragma and polling design confirmed |
| Hook cold path | Bun start plus read-only SQLite lookup: 10–20 ms | Target 50 ms |
| Names | `@vforsh/agentbus` free on npm; unscoped `agentbus` taken | Keep the scoped name; recheck at publish |
| Cited links | All return HTTP 200 | No changes |

`claude-threads` documents further facts verified with Claude desktop 2.16120: model-classified `done`/`blocked`/`working` states, `notify_when_idle` arriving late, and edit refusals in shared checkouts. They informed the phase model and the decision to keep the isolation rule in the skill.

## Revision log

2026-10-01, Claude→Claude and `claude-threads`:

- Claude→Claude became a verified direction, and milestone 5 migrates `claude-threads` onto Agentbus. The Codex wake adapter moved to milestone 6 and the optional extensions to milestone 7.
- Per-message seen state replaced client-side cursors for re-arming: `wait` returns each message once, `read` stays non-mutating. This also lets a static heartbeat prompt work.
- `delegate` opens a delegation in one step (pending worker, request, generated worker contract), shared by all three launchers.
- Delegations gained derived phases and a `delegations` table, and sessions gained display labels. Messages gained a one-line `summary`.
- `turn_finished` notices are suppressed when the worker reported explicitly in that turn. `turn_interrupted` covers a mid-turn `SessionEnd` and `wait --probe` liveness checks.
- `wait` gained `--settled` and `--probe`; Claude workers arm their own background wait after asking, so no provider-native messaging is required.

2026-09-30, bidirectional delegation:

- Both directions ship in the first release. The protocol uses parent and worker roles, and a table maps each provider role to its launcher, observer, follow-up path and wake path.
- Pending registration and `session bind` cover both providers: token claims for Claude, `thread.started` for Codex.
- The existing `claude-to-codex` runner is the Codex worker observer while `codex exec` owns the thread; Codex hooks became optional because they need per-hash trust.
- A Claude parent is woken by a background wait with a 30-minute timeout re-arm; a Codex parent keeps the heartbeat.
- Answers to a Codex worker are delivered by the Claude parent resuming the same thread through the launcher, with fork and Desktop-ownership guards. Agentbus never resumes on its own.
- `SessionEnd` became `owner_released` and no longer closes delegations; `api_error` became `turn_failed` for both providers; observation event IDs are deterministic per turn.

2026-09-30 review:

- Token-claimed pending Claude sessions replace post-launch registration and unmatched-event reconciliation; the evidence check showed `--bg` ignores `--session-id`.
- Caller identity falls back to native session environment (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`), with refusal on cross-provider ambiguity, and gains `whoami`.
- Turn binding uses `prompt_id`; task-notification prompts continue a bound turn. The launcher helper's `state=done` readiness bug is recorded, with its fix scheduled in milestone 4.
- Hooks write to SQLite directly and spool only on failure, so result capture needs no watcher process. Hooks subscribe only to six low-frequency events, print nothing, always exit 0 and tolerate a missing binary.
- Observer output became a distinct `notice` type from `system:observer`; the `error` type folded into `result` with `outcome: failed`.
- Requests open delegations; a prompt token binds turns, so later manual turns are not attributed.
- `read` and `wait` gained cursors and filters, fixing a busy loop on deliberately pending messages; `wait` accepts up to 24 hours for the background-wait pattern.
- Milestones reordered: end-to-end delegation is the first release; the Codex wake adapter, its outbox, leases and worker became a conditional later milestone.
- Journal mode is fixed to rollback in v1; `init --journal` removed; per-connection pragmas and `data_version` polling specified.
- `sequence` is a JSON integer; `read --unread` removed as redundant with the default.
