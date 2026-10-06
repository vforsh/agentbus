# Codex heartbeat restart verification

This opt-in workflow tests a saved chat heartbeat across a real Desktop app restart. It never restarts the app, launches provider workers, upgrades the installed Agentbus executable, creates a chat, or changes provider settings. Use the existing chat and checkout. Only its isolated store and its one disposable automation may be cleaned up.

The [official scheduled-task documentation](https://learn.chatgpt.com/docs/automations?surface=app) requires the app running and the local project available. It describes tasks in a chat as returning to that chat. It does not specify restart catch-up latency, replay of missed runs, or persistence guarantees for local heartbeats. Local configuration on disk corroborates the saved schedule and target; only an observed scheduled turn after restart can establish resumption on a tested version.

The 2026-10-06 app tool returns a creation/deletion JSON receipt, but `view` only reports that it rendered an automation card. `capture-view` saves that supported receipt with a **read-only** snapshot of the automation config whose lookup is documented by the tool. This is configuration evidence, not a metadata API or proof that the scheduler is alive. If either piece is unavailable or differs from the saved intent, stop and leave mail recoverable. Never edit `~/.codex` files or use another App Server to claim delivery to the Desktop owner's chat.

## Preparation before any restart

Run from the original native chat, with the external checkout mounted. Choose a fresh internal-disk directory; existing directories are refused. The harness requires `CODEX_THREAD_ID` to match and derives the Desktop app and bundled server from tool-process ancestry, recording PID **and start time**, app/CLI/Bun versions and the Agentbus source fingerprint.

```bash
experiment_dir="$HOME/.local/state/agentbus-experiments/restart-$(date +%Y%m%d-%H%M%S)"
bun /workspace/agentbus/scripts/heartbeat-restart.ts prepare \
  --dir "$experiment_dir" --thread "$CODEX_THREAD_ID"
```

This creates a private config with explicit CLI/store paths and unavailable provider binaries, three synthetic delegations, 51 progress messages, one seen-but-unacknowledged result, and one unread result. No model worker runs. The open third delegation guards against premature cleanup. Each public CLI call is saved in `receipts/`; `prepared-mail` records the two receipt states and two-page recovery scan. `experiment.json`, `heartbeat-prompt.txt`, and the complete `continuation.md` are saved before creating the heartbeat.

Through the supported app tool, create **one heartbeat** on the saved native thread, at a five-minute cadence, ACTIVE, using the saved prompt verbatim. Save the complete creation tool response as `automation-create.json`. Do not manufacture IDs or write automation files. Then:

```bash
bun /workspace/agentbus/scripts/heartbeat-restart.ts created \
  --dir "$experiment_dir" --receipt "$experiment_dir/automation-create.json"
```

Call supported `automation_update view` for that saved ID and save its whole response as `automation-view.json`. Capture the read-only corroboration and bind:

```bash
bun /workspace/agentbus/scripts/heartbeat-restart.ts capture-view \
  --dir "$experiment_dir" --receipt "$experiment_dir/automation-view.json"
bun /workspace/agentbus/scripts/heartbeat-restart.ts bind \
  --dir "$experiment_dir" --receipt "$experiment_dir/automation-evidence.json"
```

Views used for check-ins must be saved within 60 seconds. Bind records `setup_required`; the first valid original-chat run records readiness. The CLI cannot independently verify app liveness. If creation succeeded but recording its receipt failed, reconcile the existing automation by name/prompt/ID, rather than launching another.

Save a fresh supported `list_threads` receipt. **Defer the restart if any unrelated local chat is active**, or if host visibility is incomplete. Do not stop or archive somebody else's work. Preserve all experiment files even if the app is interrupted. The static heartbeat has a one-hour deadline and cleans up its own cancelled experiment if no restart is observed by then; it stays silent while unchanged.

## Actual restart and recovery

Once safe, end the preparation turn, quit the recorded Desktop app normally, and reopen that same app. Keep the machine awake, app open, and checkout mounted for at least two schedule intervals. Use the app's supported quit/open controls; the harness supplies no bypass around a unavailable app-control capability. Do not manually send a message or run `tick` to claim a scheduled return. Record quit/open times and supported pre/post automation views. If nothing runs, preserve the timeout as an unverified/failed provider gate.

The saved heartbeat checks its native chat and saved active automation, captures a fresh view bundle, then invokes `tick`. The harness detects a restart only when the app identity changes **and** the recorded old app identity is positively dead. A new shell, CLI, or backend process alone does not count. Before that, `tick` checks in but preserves all prepared mail. Its manual invocation is only a preflight check, never automatic-wake evidence.

After an observed restart, `tick` starts each `read` sweep without `--after` or `--unseen`, follows `hasMore`, and records full read/ack receipts. It handles each synthetic message by saving a durable per-message sentinel before acknowledging. After an interruption, a fresh process sees the old unacknowledged receipt, reuses the same sentinel, then acknowledges; this models a keyed side effect, not exactly-once delivery of arbitrary external actions. One handler at a time is enforced by an isolated SQLite transaction lock, automatically released on process death. The guard also requires a sentinel for every expected message; acknowledging a message without handling it cannot authorize cleanup.

The first recovery must return `cleanupReady: false` because the third delegation remains open. The heartbeat runs `finish-worker`, which publishes one keyed final synthetic result, then repeats the fresh sweep. Only `cleanupReady: true` authorizes final deletion. Save the supported deletion response as `automation-delete.json` and run:

```bash
bun /workspace/agentbus/scripts/heartbeat-restart.ts cleanup \
  --dir "$experiment_dir" --receipt "$experiment_dir/automation-delete.json"
```

Cleanup validates the exact deleted ID, requires handled mail and ended delegations, retains evidence, and immediately removes the ready binding. Retrying is safe. Cancellation uses the same supported deletion and `cleanup --abort`: it closes/settles only this disposable store and records `aborted`, which cannot earn acceptance. No automation remains monitoring after cancellation. Evidence files are retained for review; remove only this task's directory when no longer needed.

## Evidence and acceptance

Record exact versions, automation/native/Agentbus IDs, UTC times (plus user timezone if presenting them), command exits and receipts. Keep private raw app receipts in the experiment directory; publish only task-relevant excerpts. Review:

| Gate | Required observation |
| --- | --- |
| Persistence | Same automation ID and original target in pre/post supported views plus read-only configuration snapshots |
| Real restart | Old/new Desktop PID and start identities; old identity confirmed dead; recorded quit/open interval |
| Automatic resumption | Supported `read_thread` receipt for a **scheduled** turn of the original native chat after reopening, with no manual nudge |
| Recovery | Both pre-restart results read and acked; seen state retained; at least two pages; a fresh sweep recovers older unacked mail |
| Deduplication | Interrupted handling retry reuses one sentinel; keyed producer retry returns the original result; no extra native conversation |
| Final cleanup | No deletion while guard open; final result handled; exact successful deletion receipt; binding immediately unready |
| Quiet behavior | No unchanged-state reports; notification only for meaningful completion, failure or required action |

`status` reports `fixture_only` or `requires_live_receipt_review`; **no command returns `live_passed`**. A green package gate, synthetic receipt or saved TOML does not prove the live gates. The fixture suite covers recovery mechanics; scheduler persistence and resumption need the actual experiment above. Current evidence: [2026-10-06](live/heartbeat-restart-2026-10-06.md).

## Repeatable process checks

```bash
bun test --timeout 120000 /workspace/agentbus/tests/e2e/heartbeat-restart.test.ts
bun run gate
```

For a retained manual fixture experiment, use `prepare --fixture` with a disposable UUID and a new directory. Provide explicitly synthetic automation receipts. `tick --interrupt-after-handle` is fixture-only; it stops after saving a sentinel and before ack, then a normal `tick` retries. `capture-view --fixture-config` reads an isolated TOML fixture only in fixture mode. Fixtures never query or modify the real provider config. Fixture results must remain labelled separately from a Desktop restart.
