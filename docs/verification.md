# Verification and status

[Back to README](../README.md)

## Milestones

| Milestone | State |
| --- | --- |
| 1. Scaffold, contracts, config, diagnostics | Implemented |
| 2. Durable mailbox (sessions, messages, receipts, delegations, waits) | Implemented; acceptance 1–4 covered by process-level checks |
| 3. Worker result capture (Claude hooks + spool, Codex runner events, probes, phases) | Implemented at the adapter level with recorded fixtures; live Claude checks below still open |
| 4. Launcher integration and live Codex↔Claude workflows | Launchers tracked by default; Claude→Codex and Codex→Claude live gates passed |
| 5. `claude-threads` on Agentbus | Implemented; live gate passed (acceptance 13–14) |
| 6. Codex wake adapter | [Capability spike](spikes/codex-wake-2026-10-06.md) failed at backend reachability (2026-10-06); heartbeat retained, adapter deferred |

Live gates that passed are listed under [Live checks](#live-checks); everything else is proven by fixture-driven checks for recorded payload shapes, not live delivery.

## Gate

```bash
bun run gate
```

Runs Biome lint, `tsc --noEmit` (TypeScript 7), `test:integration` (mailbox, delegation, concurrency, wait, CLI) and `test:e2e` (Claude hook lifecycle from recorded payloads, Codex runner events, probes with real processes and a fake `claude` inventory, the follow-up completion gate including concurrent follow-up/result races, return-path readiness with real wait processes, and `explain` across delegation situations). All checks drive the public CLI in subprocesses against temporary stores; none touch `~/.claude` or the real mailbox. Fault injection for recovery checks: `AGENTBUS_FAULT_INJECT=wait-after-seen-commit|hook-spool`.

## Opt-in Codex heartbeat restart gate

The [restart workflow](heartbeat-restart.md) prepares private state, a complete static continuation prompt, unread and seen-but-unacknowledged results, and a guard delegation before any restart. `scripts/heartbeat-restart.ts` drives the public CLI, verifies the original native chat and saved automation intent, detects changed Desktop PID/start identity with the old owner confirmed dead, paginates fresh recovery sweeps, records keyed handling before ack, and gates final cleanup. It never restarts the app, launches a model, edits app-owned state, or installs the binary. The current app's card-only automation view is retained alongside a read-only config snapshot, explicitly weaker than observed scheduler execution.

Process checks cover interrupted handling/retry, two-page recovery, identity/automation mismatch, card-only API receipts, keyed results and guarded cleanup. They are fixture evidence. The [2026-10-06 live preflight](live/heartbeat-restart-2026-10-06.md) verified create/view/configuration/deletion and native identity, but **did not restart the app** because an unrelated local chat was active. Both disposable automations were deleted and their stores marked aborted; automatic resumption and result recovery after a real restart remain unverified. A saved automation ID or green package gate does not pass that acceptance criterion.

Recorded evidence lives in `tests/fixtures/` (Claude Code 2.1.284, Codex CLI 0.157.1); `*.synthetic.json` files follow the documented hook shapes where no live capture exists yet.

## Live checks

Verified on 2026-10-01 with five disposable Haiku `--bg` workers using per-worker `--settings` hooks (see [Pre-implementation evidence](history.md#pre-implementation-evidence)): contract claim, result attribution and Stop suppression, fallback `turn_finished`, question → background-wait wake-up → result, `PermissionRequest` with `prompt_id`, `claude stop` mid-turn → `turn_interrupted`, and `kill -9` → stale `claude agents` row but probe-confirmed `turn_interrupted`.

Claude→Codex live gate (2026-10-01): a real `codex exec` worker asked a question, the Claude parent's background `agentbus wait` re-invoked it, the answer went through `spawn.sh --resume` on the same thread ID, and the result arrived through a second wake-up.

`claude-threads` on Agentbus (2026-10-01, Claude Code 2.1.284, seven disposable Haiku children, one lead watcher armed with `wait --replace --probe 60s`): phases matched each child (`question`, `permission`, `question`, then `done`/`interrupted`/`unknown`); a question → answer → the child's own background wait → result round-trip produced no `turn_finished` notice; a child spawned after the watcher was armed (in a `claude --worktree` worktree, claimed through `delegate --allow-missing-cwd`) reported to the same watcher; a `kill -9` of an idle owner with an armed wait was confirmed dead by the probe with no hook (`turn_interrupted`; the daemon respawned the owner 3 s later); `cleanup.sh rm` removed sessions, worktrees and branches and closed open delegations.

Finding from the same run: the Claude daemon respawns a killed background owner (same session, new PID, `SessionStart source=resume`, same `--settings`) — mid-turn it resumes the turn and re-raises a pending permission prompt. The respawned owner does not adopt the old owner's background tasks: the orphaned wait consumed the parent's answer and the child was never re-invoked. Agentbus now posts `tracking_lost` (phase `unknown`, not repaired by a live-owner probe) when a resumed owner starts while the bound turn's background work is outstanding; a lead recovers with a provider-native doorbell (`SendMessage` to the child), verified live.

Codex→Claude live gate (2026-10-04, real tasks through tracked `codex-to-claude`, Codex app heartbeats `FREQ=MINUTELY;INTERVAL=5`): a worker's `result/success` committed at 16:03:46Z; the parent chat's heartbeat turn started at 16:04:49Z (63 s), read and acknowledged it at 16:06:20Z, and the heartbeat deleted itself once the chat's only delegation closed. A second chat's heartbeat stayed active while its delegation was open.

Same day, real use exposed the missing mid-task channel: a Codex parent sent three follow-ups to working Claude workers, none was read, and both workers published their results without them. Follow-ups now join the delegation and ring the doorbell. Doorbell live check (Claude Code 2.1.287, two disposable Haiku workers, isolated store): a follow-up sent during a worker's foreground command was announced by `PostToolUse` 7 s later, read, acked and honored in the result; one sent while a worker wrote a tool-free reply blocked its `Stop` (“Stop hook feedback”), after which it read, acked and published the requested result. Neither worker had a wait armed.

Still open:

- Claude: session UUID and `prompt_id` across Desktop resume, and whether per-worker `--settings` hooks stop there; background wait re-invocation in a Desktop-owned session.
- Codex: heartbeat persistence, automatic original-chat resumption and result recovery after an app restart. `CODEX_THREAD_ID` was present in this Desktop chat's tool shells on 2026-10-06; other versions/hosts still require identity verification before check-in.
