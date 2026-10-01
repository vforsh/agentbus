---
name: agentbus
description: Use the agentbus CLI to delegate work between Codex and Claude Code sessions and to talk to the agent that delegated work to you — durable mailbox, request/question/result messages, seen and acknowledgement state, delegation phases, background waits and heartbeats. Use when acting as a parent that delegated a task (read results, answer questions, wait for children) or as a worker carrying an `<agentbus-contract>` block, and for agentbus doctor/hooks/config setup. Triggers on agentbus, agentbus-contract, delegate to Claude/Codex, wait for child sessions, worker question/result.
---

# agentbus

Local, durable mailbox between agent sessions. One OS user, one host; identities are routing labels, not authentication. The mailbox is the record: a committed message survives crashes until it is acknowledged.

## Core rules

- **Reading never consumes.** `read` (also `--unseen`) changes nothing. `wait` marks only the batch it returns as *seen*. Only `ack` accepts responsibility.
- **Recover on every wake.** At startup and after every wait exit (message, timeout exit 3, error, kill), run a paginated `agentbus read --json` sweep (follow `hasMore` with `--after <cursor>`) before handling new output or re-arming. Seen-but-unacked mail may be handled twice; give side effects their own `--key`.
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
# -> workerId, requestId, contract, returnPath, returnPathStatus=setup_required
```

Launchers (`claude-to-codex`, `codex-to-claude`, `claude-threads`) append `contract` to the worker prompt, spawn the worker, then confirm with `agentbus session bind <workerId> --external-id <native-uuid>`. Do not spawn twice for one request; a crash after spawning needs reconciliation, not a second launch.

**Claude parent — one background wait for everything.** After delegating, run as a background command and end the turn:

```bash
agentbus wait --timeout 30m --probe 60s --json
```

It covers every delegation of this parent, including ones created later. On each re-invocation: recovery `read` sweep → handle questions/results/notices → `ack` what you handled → re-arm only if delegations remain open. Exactly one watcher per session. Record the armed mechanism: `agentbus session update <me> --binding-file rb.json` with `{"strategy":"background_wait","status":"ready"}`.

**Codex parent — heartbeat.** If the app's automation tool exists and monitoring is in scope, create or reuse one heartbeat on the original chat (persist its ID). Its static prompt: run the recovery `read` sweep, optionally a short `wait --timeout 2m`, report only real changes (question, result, attention notice), ack handled mail, stay quiet otherwise. Delete it after all delegations are closed and handled. Without the tool, say delivery is manual and poll with `agentbus read`.

**Batches.** `agentbus wait --settled --timeout 30m --json` snapshots currently open delegations: returns `reason: attention` immediately for questions and permission/failure/interruption/tracking-loss notices, `reason: settled` when every member is done/closed/idle, `reason: empty` if none were open. Answer attention items before re-arming.

**Answering a question.** `agentbus reply <question-id> --key answer-<question-id> --file answer.md`. Acking a question does not answer it. Claude workers wake through their own background wait; for a Codex worker whose run ended, resume the same thread through the launcher (`spawn.sh --resume <threadId>`), never while its run is active or after Desktop may own it.

**Status.** `agentbus delegations` (add `--probe` for live activity, `--all` for history, `<request-id|name>` for detail). `agentbus close <request>` abandons a delegation without a result (never stops a process).

| Phase | Meaning | Parent action |
| --- | --- | --- |
| `pending` | Not launched/claimed yet, or an answer awaits a new worker turn | Wait |
| `working` | Bound turn active, or its background work still running | Wait |
| `permission` | Worker hit a provider permission prompt (last known) | Tell the user; the prompt belongs to them |
| `question` | Worker asked; unresolved until you reply to that question ID | Answer |
| `idle` | Turn ended without a result | Read the `turn_finished` notice; follow up or close |
| `interrupted` | Latest turn failed or its process positively died | Decide: retry with a fresh request or close |
| `unknown` | Tracking lost or binding superseded by manual input | Investigate; do not take over files |
| `done` | Worker published a result (outcome shown) | Verify the worker is idle before editing its files |
| `closed` | Closed by the parent | — |

## As a worker

Your prompt carries an `<agentbus-contract version="1">` block. Follow it exactly; it fixes the CLI path, store paths and `--as`. In short:

1. `read --correlation <request-id> --json`, then `ack <request-id>`.
2. Optional `reply <request-id> --type progress --summary ...` at real milestones only.
3. Decision or blocker within the task's authorization → `reply <request-id> --type question --key q1-... --summary ... --file -`; one open question at a time. Recover an already-arrived answer with `read` before waiting. Claude: arm `wait --correlation <request-id> --timeout 30m --json` as a background command and end the turn; on every re-invocation recover, ack, re-arm if still waiting. Codex: bounded in-turn `wait`, or end the turn.
4. Finish all writes and background edits, then `reply <request-id> --type result --outcome <success|blocked|failed|unknown> --key result-... --summary ... --file -` and end the turn promptly. `blocked` hands the task back.
5. Never message the parent through provider-native channels. Provider permission prompts still belong to the user.

## Setup and diagnostics

- `agentbus doctor` — read-only readiness (store schema, spool backlog, hook installation and pinned store, provider CLIs, caller).
- `agentbus hooks claude install|uninstall|status|print [--dry-run]` — user-level Claude hooks that capture worker turns (SessionStart, UserPromptSubmit, PermissionRequest, Stop, StopFailure, SessionEnd). They print nothing and always exit 0.
- `agentbus config set codexBin=/path claudeBin=/path`, `config get|unset|import|export|path|ls`.
- `agentbus status [<session>] [--probe]`, `agentbus event drain`.

## Exit codes

`0` ok · `1` failure / doctor not ready · `2` invalid usage or input · `3` wait timed out (still run the recovery read) · `4` not found (session, message, store) · `5` conflict: retry key, ambiguous identity, wrong role, closed delegation, busy worker · `6` database busy past deadline · `130` interrupted. With `--json`, failures are `{"ok":false,"error":{code,message,exitCode,details}}` on stdout.
