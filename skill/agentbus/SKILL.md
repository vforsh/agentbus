---
name: agentbus
description: Use the agentbus CLI to delegate work between Codex and Claude Code sessions and to talk to the agent that delegated work to you — durable mailbox, request/question/result messages, seen and acknowledgement state, delegation phases, background waits and heartbeats. Use when acting as a parent that delegated a task (read results, answer questions, wait for children) or as a worker carrying an `<agentbus-contract>` block, and for agentbus doctor/hooks/config setup. Triggers on agentbus, agentbus-contract, delegate to Claude/Codex, wait for child sessions, worker question/result.
---

# agentbus

Local, durable mailbox between agent sessions. One OS user, one host; identities are routing labels, not authentication. The mailbox is the record: a committed message survives crashes until it is acknowledged.

## Core rules

- **Acceptance is explicit.** Default `read`, `show <id>` and `read --unseen` change nothing. `wait` (and the Claude worker doorbell) marks only what it delivers as *seen*. `ack` accepts responsibility; `reply` also acks its source atomically (`--no-ack` opts out). Failed replies do not ack. `read --ack` accepts only its returned page before stdout; use it only when accepting the batch, since lost output still leaves it acknowledged (recover with `read --all` or `show`).
- **Follow-ups gate success.** A worker's `success` result is refused (exit 5, `followups_pending`) while any follow-up or answer from its parent is unacknowledged; seen is not handled. Other outcomes are accepted and list the leftovers as `unhandledFollowUps`.
- **A delegation's end settles leftovers.** A result settles the worker's unacked mail of that delegation; `close` (never gated) settles the whole delegation, both sides. Settled receipts read as acknowledged with `settledReason` (`delegation_done|delegation_closed`). The result itself stays yours to ack.
- **Recover on every wake.** At startup and after every wait exit (message, timeout exit 3, error, kill), run a paginated `agentbus read` sweep (follow the More messages pointer with `--after <cursor>`) before handling new output or re-arming. Bodies are readable; `show <id>` prints one full body. Keep `--json` for scripts (`hasMore`/`cursor`). Seen-but-unacked mail may be handled twice; give side effects their own `--key`.
- **Retry with keys.** Automated sends/replies/delegations pass a stable `--key`; a retry returns the original IDs, a changed intent fails with exit 5. A keyed `delegate` retry never authorizes a second model launch.
- **Outcomes come only from `result`.** A finished turn (`notice/turn_finished`) is not success. Only a worker `result` carries `success|blocked|failed|unknown`, and every result closes the delegation.
- **Unknown stays unknown.** `tracking_lost` / phase `unknown` means evidence is missing, not that the worker stopped. Never take over a worker's files while it is `working`, `unknown` or has background work.
- **Bodies come from files or stdin** (`--file path` or `--file -`), never argv. Max 1 MiB. Summaries are one line, ≤200 chars.

## Identity

Caller resolution: `--as <address>` → `AGENTBUS_SESSION_ID` → native `CLAUDE_CODE_SESSION_ID` (`claude:<uuid>`) or `CODEX_THREAD_ID` (`codex:<uuid>`). Both native markers present → exit 5; pass `--as`. Addresses are internal UUIDs or `provider:<native-uuid>`; names are display only. `agentbus whoami` shows what resolved.

## As a parent

```bash
agentbus init --json                                         # once per machine; idempotent
agentbus session register --provider claude --external-id "$CLAUDE_CODE_SESSION_ID" --name lead --json
agentbus delegate --to codex --name executor --cwd /abs/project --key task-001 \
  --label model=gpt-6-sol --summary "Fix the parser" --file request.md --json
# -> workerId, requestId, contract, returnPath, returnPathStatus (ready only while your watcher runs)
```

Launchers (`claude-to-codex`, `codex-to-claude`, `claude-threads`) append `contract` to the worker prompt (a worker directory the launcher creates later, such as a `claude --worktree`, is delegated with `--allow-missing-cwd`), spawn the worker (Claude workers with `--settings <claudeSettings>`), then confirm with `agentbus session bind <workerId> --external-id <native-uuid>`. Do not spawn twice for one request; a crash after spawning needs reconciliation, not a second launch.

**Claude parent — one background wait for everything.** After delegating, run as a background command and end the turn:

```bash
agentbus wait --replace --timeout 30m --probe 60s --json
```

It covers every delegation of this parent, including ones created later. On each re-invocation: recovery `read` sweep → handle questions/results/notices → `ack` what you handled → re-arm only if delegations remain open. Exactly one watcher per session: arm with `--replace` to retire an earlier one; a wake with `reason: superseded` means a newer watcher is running — handle nothing and do not re-arm. Subagents share the session's identity, so only the conversation itself arms the watcher.

Readiness is derived from the running watcher, not recorded: `returnPathStatus` is `ready` (`returnReadiness.readiness: armed`) only while an unfiltered wait of yours is running and the process that armed it still exists. `not_armed` (timed out, returned, interrupted, killed), `owner_lost` (the wait outlived the session that armed it; `--replace` retires it) and `unverified`/`unknown` (no process evidence) all mean re-arm before relying on wake-ups. A `--correlation` wait covers one request, a `--settled` wait only the delegations open when armed, and a `--from`/`--type` wait none.

**Codex parent — heartbeat.** If the app's automation tool exists and monitoring is in scope, create or reuse one heartbeat on the original chat (persist its ID) and record it once: `agentbus session update codex:<thread> --binding-file -` with `{"strategy":"heartbeat","status":"ready","handle":"<automation-id>","interval":"5m"}`. Its static prompt: first `agentbus session update codex:<thread> --refresh` (the check-in that keeps it `ready`), then the recovery `read` sweep, optionally a short `wait --timeout 2m`, report only real changes (question, result, attention notice), ack handled mail, stay quiet otherwise. Agentbus cannot see app automations: a check-in older than three intervals (15 minutes without `interval`) reads as `stale`/`unknown`, never as alive. Delete the heartbeat after all delegations are closed and handled. Without the tool, record `"status":"unsupported"`, say delivery is manual and poll with `agentbus read`.

**Batches.** `agentbus wait --settled --replace --timeout 30m --json` snapshots currently open delegations: returns `reason: attention` immediately for questions and permission/failure/interruption/tracking-loss/launch-failure notices, `reason: settled` when every member is done/closed/idle, `reason: empty` if none were open. Answer attention items before re-arming.

**Follow-ups to a working worker.** `agentbus followup <request|name> --summary "..." --file -` (add `--key` when automated). It joins the delegation, and the worker cannot publish a `success` result until it acknowledges it. Exit 5 `delegation_closed` means the worker already finished or you closed it: nothing was filed; start a new request if the work must continue. Plain `send` to the worker still joins an open delegation, but after it ends it silently becomes an unrelated message — use `followup`. A running Claude worker sees it after its next tool call, or its attempt to end the turn is turned back until it reads it (doorbell hook). A Codex worker checks at milestones and before its result. An idle worker (turn ended, no wait armed) is not woken: Claude parents use `SendMessage` as the doorbell; a Codex parent waits for the result or resumes per the launcher.

**Answering a question.** `agentbus reply <question-id> --key answer-<question-id> --file answer.md`. A successful reply also acknowledges the question (`--no-ack` opts out). Acking a question does not answer it. An answer is a follow-up: the worker must ack it before `success`, and answering after the delegation ended is refused (exit 5). Claude workers wake through their own background wait; for a Codex worker whose run ended, resume the same thread through the launcher (`spawn.sh --resume <threadId>`), never while its run is active or after Desktop may own it.

**Status.** `agentbus delegations` (add `--probe` for live activity, `--all` for history, `<request-id|name>` for detail, `--global` for every parent's delegations without a caller identity). `agentbus explain <request|name>` tells one delegation's story: timeline of mail (summaries only), lifecycle evidence, binding changes and waits, why it is where it is, what is uncertain, and numbered next steps with commands (`--probe` checks liveness first; `--limit` bounds the timeline, newest kept). It changes nothing. `agentbus close <request>` abandons a delegation without a result (never stops a process).

| Phase | Meaning | Parent action |
| --- | --- | --- |
| `pending` | Not launched/claimed yet, or an answer awaits a new worker turn | Wait |
| `working` | Bound turn active, or its background work still running | Wait |
| `permission` | Worker hit a provider permission prompt (last known) | Tell the user; the prompt belongs to them |
| `question` | Worker asked; unresolved until you reply to that question ID | Answer |
| `idle` | Turn ended without a result | Read the `turn_finished` notice; follow up or close |
| `interrupted` | Latest turn failed or its process positively died, or the session ended before claiming the request (`launch_failed` notice: read its body for the cause) | Decide: retry with a fresh request or close |
| `unknown` | Tracking lost, binding superseded by manual input, or the worker's owner restarted and orphaned its background wait | Investigate (`agentbus explain <request>`); do not take over files. Restarted owner: nudge the worker through its provider (Claude: `SendMessage`) to run its contract's read command |
| `done` | Worker published a result (outcome shown) | Verify the worker is idle before editing its files |
| `closed` | Closed by the parent | — |

## As a worker

Your prompt carries an `<agentbus-contract version="1">` block. Follow it exactly. Run every command through the executable it names (`<state-dir>/workers/<worker-id>/agentbus`), which fixes the CLI, store paths and `--as`; it is one path, so keeping it in a shell variable is safe. Never put the multi-word fallback prefix in a variable: zsh and fish do not word-split it (exit 127). In short:

1. `read --correlation <request-id> --json`, then `ack <request-id>`.
2. Optional `reply <request-id> --type progress --summary ...` at real milestones only.
3. Decision or blocker within the task's authorization → `reply <request-id> --type question --key q1-... --summary ... --file -`; one open question at a time. Recover an already-arrived answer with `read` before waiting. Claude: arm `wait --replace --correlation <request-id> --timeout 30m --json` as a background command and end the turn; on every re-invocation recover, ack, re-arm if still waiting. Codex: bounded in-turn `wait`, or end the turn.
4. Run the step-1 `read` once more, handle and ack any follow-up, finish all writes and background edits, then `reply <request-id> --type result --outcome <success|blocked|failed|unknown> --key result-... --summary ... --file -` and end the turn promptly. `blocked` hands the task back. A `success` refused with `followups_pending` names the unacknowledged messages: handle and ack them, then retry with the same key.
5. Follow-ups from the parent can arrive mid-task. Claude: an `Agentbus: your parent sent …` note appears after a tool call or when you try to stop; run the commands it names (`read --from <parent>`, then `ack`). Codex: check with the step-1 `read` at milestones. Handle them within the task.
6. Never message the parent through provider-native channels. Provider permission prompts still belong to the user.

## Setup and diagnostics

- Install the worker-facing executable on the internal disk once per change of the checkout: `bun run install:bin` in the agentbus checkout (background Claude sessions may be unable to read external volumes).
- `agentbus doctor` — read-only readiness (store schema, spool backlog, hook installation and pinned store, provider CLIs, caller, and the caller's return path for its open delegations).
- Claude workers are observed through per-worker hooks: start them with `claude --bg --settings <claudeSettings>` from the `delegate` receipt. The same hooks ring the follow-up doorbell (`PostToolUse`, `Stop`). After a Desktop handoff only explicit replies and `--probe` remain. `agentbus hooks claude install|uninstall|status|print [--dry-run]` manages an optional user-level install that also covers handed-off sessions but runs in every Claude session.
- `agentbus config set codexBin=/path claudeBin=/path`, `config get|unset|import|export|path|ls`.
- `agentbus status [<session>] [--probe]`, `agentbus event drain`.
- `agentbus prune [--older-than 7d] [--dry-run]` — store maintenance: deletes `delegate`-created workers that finished and went quiet before the cutoff, with their history; never registered sessions or a parent's unacknowledged mail.

## Exit codes

`0` ok · `1` failure / doctor not ready · `2` invalid usage or input · `3` wait timed out (still run the recovery read) · `4` not found (session, message, store) · `5` conflict: retry key, ambiguous identity, wrong role, closed delegation, unacknowledged follow-ups, busy worker · `6` database busy past deadline · `130` interrupted. With `--json`, failures are `{"ok":false,"error":{code,message,exitCode,details}}` on stdout.
