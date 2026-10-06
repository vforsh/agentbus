# Codex heartbeat restart evidence — 2026-10-06

**Live restart acceptance: NOT RUN.** An unrelated local chat was active. The app was not restarted, so automatic resumption, pending-result recovery after reopening and post-restart final cleanup have not passed. The preflight and process checks below must not be promoted to a live restart result.

Task-relevant receipts and timestamps: [JSON evidence](heartbeat-restart-2026-10-06.json). Repeatable procedure: [restart workflow](../heartbeat-restart.md). Private raw receipts, the full saved continuation and mailbox history are retained in `/Users/example/.local/state/agentbus-experiments/heartbeat-restart-2026-10-06-f0000011-v2/`; the first discovery run is in the adjacent directory without `-v2`. Both disposable heartbeats were deleted through the supported API and both stores are marked `aborted`. No monitor remains armed by this task.

## Official support and actual local behavior

The [official scheduled-task documentation](https://learn.chatgpt.com/docs/automations?surface=app), opened on 2026-10-06, requires the app running for local projects and describes a scheduled task in a chat as returning to that chat. It does not specify local-heartbeat restart persistence or missed-run catch-up. This is a missing guarantee, not evidence that restart resumption is impossible.

Actual supported tool behavior differed from the initial metadata assumption:

- Creation returns prose plus JSON containing `automationId`, `mode: create`, `status: ACTIVE`.
- `view` returns only `Rendered automation card in the app.`; it supplies no target/status/prompt JSON. The harness therefore saves that supported receipt with a read-only snapshot from the documented automation-config lookup. This verifies saved configuration only. It is not a replacement metadata API or a scheduler-liveness claim.
- Deletion returns prose plus JSON containing the exact `automationId`, `mode: delete`, and `deleteStatus: deleted`.
- `list_threads` rejects a limit above 50. A supported 25-row snapshot confirmed an unrelated active local chat; no exhaustive idle-host claim was needed or made.
- CUA app inspection was unavailable: `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.` No app-state edits or alternate UI controls were used.

The first disposable automation (`agentbus-restart-experiment-f0000012`, experiment `f0000012-0000-4000-8000-000000000012`) established the actual card-only receipt shape. It was deleted without running recovery or restarting the app. The second experiment exercised the adapted supported-tool/config boundary and original-chat preflight.

## Second preflight identity and timing

| Evidence | Observed value |
| --- | --- |
| Original chat | `f0000011-0000-4000-8000-000000000011` — Original experiment chat (identifier omitted) |
| Experiment | `f0000017-0000-4000-8000-000000000017` |
| Disposable heartbeat | `agentbus-restart-experiment-f0000017`; persisted kind `heartbeat`, ACTIVE, original target, exact saved static prompt |
| macOS / Bun | `15.7.3 arm64` / `1.4.2+744846f84` |
| Desktop app | `26.930.61225`, build `13232`, installed as `/Applications/ChatGPT.app` |
| PATH and bundled CLI | Both `codex-cli 0.160.1` |
| Original Desktop identity | PID `93084`, UTC start `Tue Oct 6 05:31:52 2026` |
| Owning bundled server | PID `93393`, UTC start `Tue Oct 6 05:31:57 2026`; derived from the tool-process ancestry |
| Preparation | `15:05:25.464Z` (18:05:25.464 Moscow) |
| Automation creation | `15:06:13.051Z` |
| Manual original-chat check-in | `15:06:22.580Z`, 9.529 s after creation |
| Cancellation cleanup receipt | `15:07:09.855Z` |

`CODEX_THREAD_ID` in this Desktop tool shell equalled the original native chat ID. The manual `tick` independently captured the same app/owner identity and returned `awaitingRestart: true`, `expired: false`, `cleanupReady: false`. It preserved **all 53 pending messages**, including both results; it created zero handling sentinels. This was a manually invoked preflight, not an observed scheduled wake.

Prepared results were `f0000029-0000-4000-8000-000000000029` (seen, not acknowledged) and `f0000016-0000-4000-8000-000000000016` (unseen, not acknowledged). The mailbox baseline recorded 53 messages over two recovery pages. The three request IDs and exact seen timestamp are in the JSON and raw CLI receipts. Workers were synthetic mailbox producers with unavailable provider executables; no native model session was launched.

The supported thread snapshot at `15:07:05Z` still reported Unrelated active chat (identifier omitted) as active on the local host. Restarting would interrupt unrelated work, contrary to the task constraints. The disposable heartbeat was deleted, then `cleanup --abort` closed/settled only its isolated store. The parent binding immediately became `setup_required` with `handle: null`; the automation's config no longer existed. Abort receipts are not normal result-handling or successful post-restart-cleanup evidence.

## Process evidence, separate from live acceptance

The end-to-end suite drives `scripts/heartbeat-restart.ts` in fresh real processes against disposable stores and explicitly synthetic API receipts. It covers:

- Unread and seen-but-unacknowledged results, 53-message/two-page recovery and fresh sweeps after process restart.
- Interruption after durable handling but before ack; retry uses one sentinel and recovers old mail. Missing handling evidence prevents cleanup even if the inbox was acknowledged.
- A competing handler, positive process death with `SIGKILL`, lock release and subsequent recovery.
- Wrong native chat, changed ID/target/prompt, paused/cron records, absent metadata, headless preparation refusal and existing-directory refusal.
- Actual prose-plus-JSON create/delete and card-only view receipt shapes, corroborated by isolated read-only TOML fixtures.
- Open-guard cleanup refusal, keyed final-result retry, last-result handling, repeated cleanup, immediate readiness reset and scoped cancellation.

All six restart-workflow checks passed. Final `bun run gate` passed lint, typecheck and **154 process tests**: 59 integration, 80 end-to-end, 15 compiled release checks. The command exited 0; stage timings and the log path are recorded in the JSON. These are fixture/process evidence for mailbox and workflow mechanics; they cannot establish Desktop scheduler persistence, automatic scheduled-turn identity or provider catch-up semantics. No live gate is inferred from them.

The full gate also exposed an existing fixture race: a direct harness read threw `SQLITE_BUSY` during a wait-arm commit, leaving a live waiter that affected two later readiness assertions. Harness reads/writes now use the same bounded five-second busy deadline as public CLI commands. The original readiness suite is rerun with the full gate; provider behavior is unchanged.

## What remains to pass

When the host can be restarted without interrupting unrelated work, prepare a fresh experiment from the original chat using the saved workflow. Keep its automation active through an actual normal quit/reopen and collect same-ID pre/post views/config snapshots, old/new app identities with the old process dead, a supported `read_thread` receipt for an automatically scheduled turn after reopening, result read/ack receipts, deduplicated recovery, the open-guard checkpoint and final deletion/readiness-reset receipt. Record elapsed delay and missed-run behavior as observations of that app version.

No separate App Server, wake daemon, provider setting, global hook, new branch/worktree or installed Agentbus upgrade was introduced. The native-wake [capability spike](../spikes/codex-wake-2026-10-06.md) remains deferred independently of this restart gate.
