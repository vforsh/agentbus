---
name: agentbus
description: Use the agentbus CLI to delegate work between Codex and Claude Code sessions and to talk to the agent that delegated work to you — durable mailbox, request/question/result messages, seen and acknowledgement state, delegation phases, background waits and heartbeats. Use when acting as a parent that delegated a task (read results, answer questions, wait for children) or as a worker carrying an `<agentbus-contract>` block, and for agentbus doctor/hooks/config setup. Triggers on agentbus, agentbus-contract, delegate to Claude/Codex, wait for child sessions, worker question/result.
---

# agentbus

Durable local mailbox between agent sessions. One OS user, one host; identities are routing labels, not authentication. A committed message survives crashes until it is acknowledged.

## Core rules

- **Acceptance is explicit.** Plain `read` and `show <id>` change nothing. `wait`, `read --mark-seen` and the Claude doorbell mark their page *seen*, which does not mean handled. `ack` accepts; `reply` acks its source in the same commit (`--no-ack` opts out). `take` and `ask` acknowledge what they print, committing before output; lost output is recoverable with `read --all` or `show <id>`.
- **Recover on every wake.** After every wait exit (mail, timeout exit 3, error, kill), sweep before handling new output or re-arming: `agentbus take` as a parent, otherwise a paginated `read --mark-seen` (follow `--after <cursor>`).
- **Keys.** `reply` keys itself: one result per delegation, one key per question, and identical progress or answers collapse. Pass a stable `--key` to automated `send`, `followup` and `delegate`; a retry returns the original IDs, changed intent fails with exit 5, and a keyed `delegate` retry never authorizes a second launch. Seen-but-unacked mail may be handled twice, so give side effects their own keys.
- **Outcomes come only from a result.** `notice/turn_finished` is not success. Every result (`success|blocked|failed|unknown`) closes the delegation. A `success` is refused (exit 5, `followups_pending`) while parent follow-ups or answers are unacknowledged.
- **A delegation's end settles leftovers.** A result settles the worker's unacked mail and the parent's progress from it; `close` settles both sides. Settled receipts carry `settledReason`. The result itself stays the parent's to ack.
- **Unknown stays unknown.** Phase `unknown` or `tracking_lost` means missing evidence, not a stopped worker. Never take over a worker's files while it is `working`, `unknown` or has background work.
- **Bodies come from files or stdin** (`--file path|-`), never argv; at most 1 MiB. Summaries: one line, ≤200 chars.

Caller identity: `--as` → `AGENTBUS_SESSION_ID` → `CLAUDE_CODE_SESSION_ID` (`claude:<uuid>`) or `CODEX_THREAD_ID` (`codex:<uuid>`); both native markers present → exit 5, pass `--as`. `agentbus whoami` shows the result. Names are display only.

## As a worker

Your prompt carries an `<agentbus-contract>` block: follow it exactly, running every command through the single executable it names (safe in a shell variable; never put the multi-word fallback in one). In short: `read` and `ack` the request; `ask` the parent for decisions (Claude: in the background, then end the turn; it wakes you with the answer, and re-running never posts twice); `finish --outcome …` publishes your one result and, for a success, shows any unhandled parent mail instead (handle, `ack`, run it again). Never message the parent through provider-native channels; provider permission prompts belong to the user.

## As a parent

**Own the return, not just the launch.** Infer the mode from the requested deliverable:

- **Await** (default for a consultation, review, draft or implementation): bring the verified result back here, even from a new session. A launch receipt is progress, not completion.
- **Notify:** background work with a later return. Establish the wake path before ending the turn (reuse an existing watcher or heartbeat); if none exists, keep waiting in-turn or report the limitation.
- **Handoff:** only when the user explicitly wants just a launched session. Report access and ownership; promise no later answer.

```bash
agentbus init --json                                         # once per machine; idempotent
agentbus session register --provider claude --external-id "$CLAUDE_CODE_SESSION_ID" --name lead --json
agentbus delegate --to codex --name executor --cwd /abs/project --key task-001 \
  --label model=gpt-6-sol --summary "Fix the parser" --file request.md --json
# -> workerId, requestId, contract, returnPath, returnPathStatus
```

Launchers (`claude-to-codex`, `codex-to-claude`, `claude-threads`) append `contract` to the worker prompt, spawn the worker (Claude workers with `--settings <claudeSettings>`; a directory created later, such as `claude --worktree`, needs `--allow-missing-cwd`), then confirm with `agentbus session bind <workerId> --external-id <native-uuid>`. Never spawn twice for one request; a crash after spawning needs reconciliation, not a second launch.

**Collect with `agentbus take [<request|name>]`.** It prints your delegations' new mail grouped per delegation (result and messages in full, unanswered questions, notices, latest progress), acknowledges all of it except questions, and ends with `Next:` steps, including whether to re-arm. `--peek` acknowledges nothing. Prefer it to `read` + `ack` pipelines.

**Answer** with `agentbus reply <question-id> --file -`; it also acks the question (acking alone answers nothing). The worker must ack the answer before `success`. Answers or follow-ups after the delegation ended are refused (exit 5).

**Follow up** with `agentbus followup <request|name> --summary … --file -`; exit 5 `delegation_closed` means nothing was filed. Use `followup`, not `send`: after the delegation ends, `send` silently becomes an unrelated message. A running Claude worker gets it after its next tool call or when it tries to stop (doorbell); a Codex worker checks at milestones and before its result. An idle worker is not woken: Claude parents nudge with `SendMessage`; Codex parents resume through the launcher (`spawn.sh --resume <threadId>`), never while its run is active or after Desktop may own it.

**Claude parent: one background wait.** After delegating, run `agentbus wait --ensure --timeout 30m --probe 60s --json` as a background command and end the turn. It covers every delegation of this session, including later ones. `reason: already_watched` means another live wait (an earlier one, or the agentbus-threads mod) wakes you: just end the turn. On each wake run `take` and follow `Next:`. One watcher per session: `--replace` retires the others (use it for `owner_lost`); a wake with `reason: superseded` means do nothing and do not re-arm. Subagents share the identity, so only the conversation arms the watcher.

**Codex parent, await mode:** `take`, handle, then `agentbus wait --replace --timeout 60s --probe 60s --json` in bounded calls while work is open, recovering after every exit. A timeout never turns await into handoff.

**Codex parent, notify mode (heartbeat).** If the app's automation tool exists and monitoring is in scope:
- Create or reuse one heartbeat on the original chat; reconcile a saved ID through the app tool before creating another. Persist its ID, the native thread ID, state/config paths and a static recovery prompt before ending the turn. Never edit app-owned files.
- Record the binding as `status: setup_required` until the first check-in; creation proves configuration, not a run. Missing, paused or mismatched evidence means `setup_required` or `unsupported`, never `ready`.
- Each run verifies it is the original chat (`CODEX_THREAD_ID`; a hardcoded `--as` is not evidence), reconciles the heartbeat, records `ready` with ID and cadence on the first check-in, then `session update codex:<thread> --refresh`. Sweep `read --mark-seen --json` from the beginning, paginating only within the sweep (not `take`: a run dying after its ack loses mail; not `--unseen` or a saved cursor). Handle and ack, key side effects, and stay quiet without changes. A check-in older than three intervals (15 min default) reads as `stale`.
- After every delegation is closed and handled, delete the saved heartbeat, keep the receipt and record `{"strategy":"heartbeat","status":"setup_required","handle":null}` via `--binding-file -`; cleanup is safe to repeat. Without automation tools record `"status":"unsupported"` and poll with `read`. Restart survival is unverified ([restart workflow](../../docs/heartbeat-restart.md)).

**Readiness** comes from the running watcher: `ready`/`armed` only while an unfiltered wait of yours runs and its arming process exists. `not_armed`, `owner_lost` and `unverified`/`unknown` all mean re-arm. A `--correlation` wait covers one request, `--settled` the delegations open when armed, `--from`/`--type` none.

**Batches:** `agentbus wait --settled --replace --timeout 30m --json` returns `attention` at once for questions and permission/failure/interruption/tracking-loss/launch-failure notices, `settled` when all members are done, closed or idle, `empty` if none were open. Handle attention before re-arming.

**Status:** `agentbus delegations` (`--probe` live activity, `--all` history, `--global` every parent). `agentbus explain <request|name>` gives the timeline, evidence, uncertainty and numbered next steps; it changes nothing. `agentbus close <request>` abandons a delegation without a result and stops no process. Retrospective delivery metrics: `agentbus metrics --global --since 14d --group-by direction` ([docs/metrics.md](../../docs/metrics.md)).

| Phase | Meaning | Parent action |
| --- | --- | --- |
| `pending` | Not launched or claimed yet, or an answer awaits a new worker turn | Wait |
| `working` | Bound turn active, or its background work still running | Wait |
| `permission` | Worker hit a provider permission prompt (last known) | Tell the user; the prompt is theirs |
| `question` | Unresolved until you reply to that question ID | Answer |
| `idle` | Turn ended without a result | Read the `turn_finished` notice; follow up or close |
| `interrupted` | Turn failed, process died, or session ended before claiming (`launch_failed`: read its body) | Retry with a fresh request, or close |
| `unknown` | Tracking lost, binding superseded, or the owner restarted and orphaned its wait | `explain`; never take over files. Restarted owner: nudge the worker (Claude: `SendMessage`) to run its read command |
| `done` | Result published (outcome shown) | Verify the worker is idle before editing its files |
| `closed` | Closed by the parent | — |

## Setup and diagnostics

- `agentbus upgrade` (npm) or `bun run upgrade` (checkout) builds, smoke-tests and installs the worker executable on the internal disk, backing up and migrating the store. Offline only: open delegations, live waits, queued hook events and newer schemas are refused; never close real work to get past it. `build-info --json` shows the embedded commit and schema.
- `agentbus doctor`: read-only readiness (build freshness, schema, spool, hooks, provider CLIs, caller, return path).
- Claude workers are observed through per-worker hooks (`claude --bg --settings <claudeSettings>`), which also ring the doorbell. `agentbus hooks claude install|uninstall|status|print` manages an optional user-level install that also covers handed-off sessions.
- `agentbus config set codexBin=… claudeBin=…`; `status [--probe]`; `event drain`; `prune [--older-than 7d] [--dry-run]` deletes finished, quiet `delegate`-created workers (never registered sessions or unacked parent mail).

## Exit codes

`0` ok · `1` failure / doctor not ready · `2` invalid usage · `3` wait or ask timed out (still recover) · `4` not found · `5` conflict (key, identity, role, closed delegation, `followups_pending`, open question, busy worker) · `6` database busy · `130` interrupted. With `--json`, failures are `{"ok":false,"error":{code,message,exitCode,details}}` on stdout.
