# Protocol

[Back to README](../README.md)

- **Envelope v1**: `id`, `sequence`, `from`, `to`, `type` (`message|request|progress|question|result|notice`), `summary`, `body`, `createdAt`, `correlationId` (root request), `inReplyTo`, `idempotencyKey`, `outcome` (results only), `notice` (`{kind, observationId, provider, truncated?, originalBytes?}`), `turnRef`, `seenAt`, `acknowledgedAt`.
- **Roles**: `progress`/`question`/`result` go from a delegation's worker to its parent via `reply`; a parent answers with a `message` reply to the question ID. Notices come only from `system:observer` and cannot be replied to. One open delegation per worker, one unresolved question per delegation; every result is terminal.
- **Follow-ups**: `followup <request>` sends parent mail into an open delegation and is refused (exit 5, `delegation_closed`) once it has ended; a parent's plain `send` to the worker of its open delegation also joins it, but silently becomes an ordinary message afterwards. Answers to questions are follow-ups too, and parent replies into an ended delegation are refused. Claude workers get follow-ups through the doorbell mid-turn.
- **Completion gate**: a `success` result is refused (exit 5, `followups_pending`, listing the IDs) while any parent follow-up or answer of the delegation is unacknowledged by the worker; seen is not handled. The check and the close share one transaction with `followup`, so in either order a follow-up is handled or visibly refused. Refused attempts consume no retry key. `blocked`/`failed`/`unknown` results are accepted and report leftovers as `unhandledFollowUps` (also in `delegations`/`explain` as `followUps.unhandled`); the parent's `close` is never gated.
- **Default keys**: a `reply` without `--key` gets one: `auto:result:<request>` (one result per delegation), `auto:question:<request>:<n>` (the n-th question; an identical retry of the latest question reuses its key), and for progress and answers `auto:progress:<request>:<hash>` / `auto:answer:<question>:<hash>`, so identical retries collapse and new text is new mail. Other replies stay unkeyed; an explicit `--key` always wins.
- **Settlement**: a delegation's terminal transition acknowledges mail nobody needs to handle any more, with `settledReason`: a result settles the worker's side and the parent's progress from that delegation, which the result supersedes (`delegation_done`); a parent's `close` the whole correlation (`delegation_closed`). The result, questions, messages and notices stay with the parent. Schema v8 backfills this for finished delegations.
- **Parent names**: an unnamed parent is named `<checkout folder>: <first request title>` when it opens its first delegation, for listings and metrics. Names are display-only; an explicit `--name` is never overwritten.
- **Return path**: `returnPathStatus` (`ready|setup_required|unsupported|unknown`) and `returnReadiness` in `delegate`, `delegations`, `explain` and `doctor` are derived from current evidence each time, never from a flag. A background wait counts (`armed`) while its process (PID plus start time) and the ancestors that armed it are alive, it has not expired and it covers the delegation: unfiltered waits cover every delegation of the session, including later ones; `--correlation` one request; `--settled` the delegations open when armed; `--from`/`--type` none. A killed or timed-out wait is `not_armed`, a wait whose owner exited is `owner_lost`, and an arm whose process cannot be checked (or predates schema v6) is `unverified` (`unknown`). Heartbeats are app-only, so a Codex parent records a check-in on each run (`session update <me> --refresh`); one older than three binding `interval`s (default 15 minutes) is `stale` (`unknown`). Delegation rows store only the proposed strategy and its setup reason; schema v9 dropped the stored status, which was never updated after opening.
- **Delivery**: unseen → seen (by `wait`, the doorbell or explicit `read --mark-seen`) → acknowledged (by `ack`, or by settlement). Concurrent waits partition, they do not broadcast; run one watcher per session. `wait --replace` enforces that: it retires the caller's other running waits, which exit 0 with `reason: superseded` without claiming mail.
- **Worker contract v1**: delimited `<agentbus-contract version="1">` block naming request, worker, parent and provider, whose commands run a per-worker executable (`workerBin`, `<state-dir>/workers/<worker-id>/agentbus`) that fixes `--state-dir`, `--config` and `--as`; a single path, so it survives a shell variable in zsh and fish. The first Claude `UserPromptSubmit` carrying exactly one unquoted block, from the expected directory, claims the pending worker.
- **Observation**: Claude hooks and Codex runner events become turn bindings and observations. `turn_finished` notices are suppressed when that exact turn produced a question or result. Task notifications continue a delegated Claude turn only with proven provenance: a verified wait arm recorded by `agentbus wait` or `ask` inside that turn, or a background task first seen in that turn's Stop inventory against a known baseline. Anything else supersedes the binding (phase `unknown`, `tracking_lost` notice).
- **Ordering**: hook events of one session commit in capture order. While any event of that session sits in the spool, later events drain it first or queue behind it; a delayed prompt or Stop never rebinds or overwrites a newer turn. Permission and failure events are posted only when attributable to a bound turn.

## Returning delegated work

A consultation, review, draft or implementation request defaults to returning the verified result in the
original chat, even when a separate session is requested. A launch receipt is only progress. Codex parents
keep the current turn open with a recovery `read --mark-seen --json` sweep and bounded foreground
`wait --replace --timeout 60s --probe 60s --json`; continue the same tool process, handle questions and
ack handled mail before re-arming. Timeout never means completion or changes the return mode. Claude
parents use one background `wait --ensure` and collect the delivered questions/results with `take` on wake.

Use a heartbeat when the user requests background work with a later return; set it up before ending
the turn. Launch-only/continue-there is explicit handoff, with no promise of a later reply here. The CLI
cannot itself create an app heartbeat or consume an agent's result: supported launchers and their skills
own this loop. Missing wake support must be reported, never silently treated as successful setup.

## Codex runner events

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
