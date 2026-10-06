# Agentbus history

Completed milestone task lists, resolved questions, recorded evidence and the revision log, kept for provenance.
[PLAN.md](../PLAN.md) is the live design; where they disagree, PLAN.md wins.

## Completed milestones

Task lists and exit conditions as planned. Live gate results are in [Pre-implementation evidence](#pre-implementation-evidence) and the README's Live checks.

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
- Enforce role/correlation rules, one open delegation per worker and terminal-state races in database transactions. Recover keyed calls before checking current task state; retain original contract versions.
- Implement `delegations` with phases derivable from messages alone; observation-based phases arrive in milestone 3.
- Commit before printing receipts; handle busy deadlines and Ctrl-C.
- Verify separate OS processes, Unicode bodies, long stdin input, concurrent keyed senders/delegators, pagination beyond 50 messages, restart recovery and recipient-scoped acknowledgements. Inject a failure after a wait's seen commit but before stdout; prove startup/heartbeat/timeout recovery finds the message.

Exit condition: the mailbox satisfies acceptance criteria 1–4 with provider adapters disabled.

### 3. Worker result capture

- Run the remaining Claude checks first, with disposable sessions:
  - The session UUID survives Desktop resume; new prompt IDs remain observable and correctly associated with their own turns.
  - Per-worker `--settings` hooks fire under the background owner; confirm they stop after Desktop resume (optional user-level hooks: confirm they continue).
  - A background wait armed in a Desktop-owned session re-invokes it.
  - `SessionEnd` fires on `claude stop` of a working session.
  - Task-notification provenance distinguishes delegated waits from unrelated background tasks; timeout and completion-before-Stop cases remain attributable.
  - Permission request/resolution and background-task/cron metadata support the proposed phases and handoff guard. Document uncovered prompt types rather than claiming complete permission observation.
- Implement `event ingest` with stable captured occurrence IDs, token claims, bounded spool/drain, durable turn bindings, notices with suppression and interruption, and observation-based phases. Exercise out-of-order replay and spool-only changes while a wait is already polling.
- Implement `hooks claude print|install|uninstall|status`.
- Implement batched probes: Claude inventory with optional job diagnostics, Codex runner and child process identities. Expose them through `status --probe`, `delegations --probe` and `wait --probe`; missing evidence yields tracking loss, and stale probes cannot change a newer run.
- Drive `--source runner` with recorded `codex exec` fixtures through the public CLI; the live runner integration lands in milestone 4.

Exit condition: acceptance criteria 5–8 and 11 at the adapter level, including documented degraded-capture boundaries. Supported Claude events commit through the hook alone when the store is available; deferred capture drains later. Codex runner fixtures exercise equivalent lifecycle distinctions; outcome remains unknown when only final text exists. Live runner coverage is still required in milestone 4.

### 4. End-to-end delegation between providers (first release)

- Write the consumer skill under `skill/agentbus/SKILL.md`: identity, message types, seen state, acknowledgements, outcomes, the parent loop per `returnPath`, the worker role, the question round-trip and recovery.
- Integrate `codex-to-claude`: `delegate`, durable launch manifest, contract, post-launch `session bind`, and `reply --type result` in place of the ad hoc `result.md` handshake. Apply the fresh-idle/background-task/cron handoff guard, including capture after a result. Its helper remains the only handoff controller.
- Integrate `claude-to-codex`: durable run IDs, sanitized worker environment and explicit state paths, bind on `thread.started`, incremental event ingestion, and terminal capture before optional naming/handoff. Add the cross-run ownership lock and persisted Desktop-open marker to both launcher and Desktop helper. `last-message.md` stays as each run's local record.
- Exercise concurrent resumes, resume-versus-Desktop, launch success followed by lost launcher output, and a killed runner with a live child. Never accept a duplicate conversation as successful recovery.
- Document both parent lifecycles: one reusable Codex heartbeat with unconditional recovery and cleanup, and the Claude background wait with `--probe`, timeout recovery and a single watcher for nested roles. Report unavailable capabilities as manual delivery.
- Change launchers in their canonical `agent-skills` source, not copied installed links. Keep compatibility/rollback instructions for the separate repositories; switch only after their new path passes.
- Add README installation, doctor/config/hooks examples, protocol contract and a provider support matrix per role.
- Run the full gate, then `bun link`; verify the installed command outside the checkout.

Exit condition: acceptance criteria 1–12, including 9 and 10 with both disposable live workflows below and their recovery variants; no duplicate conversations or competing file edits:

- Codex→Claude: the result returns to the original Codex chat through a heartbeat after that chat's first turn ended.
- Claude→Codex: the parent is re-invoked by its wait, answers one worker question by resuming the same thread ID, and then receives the result.

### 5. `claude-threads` on Agentbus (Claude→Claude)

- Replace the tracked path of `spawn.sh` with `delegate` (name, labels, contract), launch reconciliation and `session bind`. Append the skill's isolation rule after the contract, and drop the report-specific `--add-dir`, `--lead` and lead-name resolution.
- Replace `wait.sh` and `status.sh` with `agentbus wait --timeout 30m --probe 60s` (`--settled` for batches) and `agentbus delegations`.
- Rewrite `cleanup.sh` around `delegations --json`; `rm` also closes the delegation. Delete `threads.py`.
- Rewrite `SKILL.md`: the phase table replaces the lifecycle table, `report.md` and `SendMessage` leave the contract, and Verified Facts that no longer apply are removed.
- Verify with disposable children:
  - Three children: one asking a question, one hitting a permission prompt, and one killed with `kill -9`.
  - A child spawned after the watcher was armed.
  - No redundant normal-finish wake after a question; a subsequent crash still surfaces.
  - The phase table matches each child.
  - Answering a question re-invokes the child through its own background wait.

Exit condition: acceptance criteria 13–14; the skill's scripts no longer read `claude agents`, job state or transcripts except through `agentbus --probe`.

## `claude-threads` before Agentbus

Before milestone 5, `claude-threads` implemented its own tracking in `threads.py` (673 lines):

- A per-lead registry of `meta.json` files.
- A `report.md` contract with a parsed `Status:` line.
- A watcher that polls `claude agents` and `~/.claude/jobs/*/state.json`.
- Heuristics that second-guess model-classified states.
- Transcript parsing to detect whether a child already messaged its lead.
- Lead addressing through the ListAgents name or a `uds:` socket, which break on rename or app restart.

The plan expected `threads.py` deleted, `wait.sh` and `status.sh` replaced by the commands themselves, and the scripts to shrink from about 980 to about 300 lines (an estimate, not an acceptance criterion). Actual result: about 980 → 630 lines (see the milestone 5 revision log entry). Each launcher switched only after its new path passed the live gates.

## Resolved implementation questions

Moved from PLAN.md's open questions once answered. The milestone number each question belonged to is in parentheses.

| Question | Answer and evidence |
| --- | --- |
| Can a task notification be positively associated with its originating delegated task, including completion before Stop and after unrelated manual input? (3) | Yes, through the wait receipt: live 2026-10-01, a worker's own background `agentbus wait` woke it after the parent answered and the notification was proven a continuation through the receipt. The implemented rule accepts a wait arm recorded by `agentbus wait` inside the bound turn (so completion before Stop stays attributable) or a background task first seen in that turn's Stop inventory against a known baseline; manual prompts and unrelated notifications supersede the binding. The non-wait cases are covered by `tests/e2e` fixtures, not live runs. |
| Does `SessionEnd` fire when a working Claude session is stopped mid-turn, and what does `claude agents` show after `kill -9`? (3) | `claude stop` during a permission prompt fired `SessionEnd` (`reason: other`) → `turn_interrupted` (live 2026-10-01). `kill -9` fires no hook; the first run left a stale `state: working` row without `pid`/`status`, so death is confirmed by the probe's PID+start identity. The milestone 5 gate found the daemon now respawns a killed owner within seconds (same session, new PID, `SessionStart source=resume`), so a probe-confirmed death may be followed by a respawn; a resumed owner with outstanding background work posts `tracking_lost`. |
| Does the installed Codex JSON stream expose a native turn ID useful for later cross-source deduplication? (1, 7) | No. In Codex CLI 0.157.1 `turn.started` carries no ID (`tests/fixtures/codex/exec-success.jsonl`); v1 binds runs by its own durable `runId`. Codex hooks do report `turn_id`, so milestone 7 still needs proven cross-source correlation. |
| Does `codex exec resume` from the runner keep the thread ID and pass the new environment to tool shells? (4) | Thread ID kept: Claude→Codex live gate 2026-10-01 delivered the answer with `spawn.sh --resume` on the same thread and received `result/success`. The resumed worker reached the mailbox; its contract also carries explicit `--as`, so identity does not depend on environment propagation. |
| Can the target Codex app create, run and remove one heartbeat on the original chat? (4) | Yes: Codex→Claude live gate 2026-10-04 (`FREQ=MINUTELY;INTERVAL=5`) woke the parent chat 63 s after the result, read and acknowledged it, and the heartbeat deleted itself once the chat's only delegation closed. Restart survival and headless absence remain open in PLAN.md. |
| Which isolated provider configuration can exercise Desktop hooks without tests rewriting the user's settings? (3–4) | Per-worker hooks (decision 2026-10-01): `delegate --to claude` writes a private settings file passed with `claude --bg --settings`, so live checks run with isolated stores and never touch `~/.claude/settings.json`. User-level install stays an explicit, optional setup outside the test suite. |

## Pre-implementation evidence

The following experiments were recorded by the earlier plan on 2026-09-30 with Claude Code 2.1.284 and Codex CLI 0.157.1, using disposable sessions reported as stopped. This review preserves those reports; it did not rerun live model sessions. Capture reproducible fixtures and exact versions during implementation rather than treating this table as a current compatibility guarantee.

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
| Live check 2026-10-01, five Haiku `--bg` workers with per-worker `--settings` hooks (Claude Code 2.1.284) | Contract `UserPromptSubmit` claimed each pending worker; a result was attributed to its bound turn and its later Stop posted nothing; a worker without a result produced a `turn_finished` notice with its final text; a question suppressed the Stop notice, the worker's own background `agentbus wait` woke it after the parent answered and the task notification was proven a continuation through the wait receipt | Per-worker hooks, claim, notice suppression and background-wait follow-ups confirmed live |
| Same run: permission and stop | `PermissionRequest` carried `prompt_id`; the inventory row showed `status: waiting`, `waitingFor: "permission prompt"`, `state: blocked`; `claude stop` during the prompt fired `SessionEnd` (`reason: other`) → `turn_interrupted` | Exact permission attribution works; mid-turn stop interrupts |
| Launcher check 2026-10-01: background worker reading the external volume | Inside a later `claude --bg` worker, hooks and Bash could `stat` files under `/Volumes/Example` but `read` failed with `Operation not permitted` (macOS privacy control); the home directory stayed readable. Bun then executed the unreadable extensionless `bin/agentbus` through its shebang, which re-ran the same failing Bun: an unbounded process chain | Workers and hooks run a compiled executable on the internal disk (`bun run install:bin`); the source fallback uses `src/main.ts`, which fails instead of looping |
| Same check: `--mode manual` worker with the per-worker `permissions.allow` rule for the Agentbus CLI | Contract commands ran without prompts; the worker's later `Write` raised `PermissionRequest` → `permission_request` notice, phase `permission`, handoff not ready; `claude stop` → `turn_interrupted` | Pre-allowing only the CLI keeps the session's permission mode for everything else |
| Live gate 2026-10-01, Claude→Codex (Codex CLI 0.157.1, `gpt-6-luna`/low) through tracked `claude-to-codex` | The Codex worker asked a question and ended its run; this Claude parent's background `agentbus wait` re-invoked it; the answer was delivered with `spawn.sh --resume`, which kept the thread ID; a second wake-up delivered `result/success`; all launcher locks were released | Acceptance criterion 10 met for Claude→Codex |
| Fake-codex runner checks | Retry of the same task recovered the launch instead of starting another run; a concurrent resume was refused by the thread lock; a resume after `desktopOpenRequested` was refused; runner `kill -9` with a live child → `tracking_lost`, then both dead → `turn_interrupted` | Launch, resume and Desktop ownership guards behave as specified |
| Same run: `kill -9` of the owner (`claude bg-spare`) | No hook fired; the `claude agents` row stayed `state: working` with no `pid` or `status`; the probe's recorded PID+start identity confirmed death → `turn_interrupted` | Provider state goes stale after a crash; identity-based probes are required |
| Live gate 2026-10-01, `claude-threads` on Agentbus (seven Haiku `--bg` children, one lead `wait --replace --probe 60s`) | Phases matched each child; question → answer → child's own wait → result posted no `turn_finished`; a child spawned after arming (in a `claude --worktree` worktree) reported to the same watcher; probe-confirmed death of a killed idle owner → `turn_interrupted` with no hook; `cleanup.sh rm` removed sessions, worktrees and branches and closed open delegations | Acceptance criteria 13–14 met |
| Same run: `kill -9` of background owners (idle with an armed wait, and mid-turn at a permission prompt; four repeated kills) | The daemon respawned every owner within seconds: same session, new PID, `SessionStart source=resume`, same `--settings`; mid-turn it resumed the turn and re-raised the permission prompt. The respawned owner did not adopt the old owner's background tasks (`inFlight.tasks: 0`); the orphaned wait consumed the parent's answer and the child was never re-invoked. A `SendMessage` doorbell made the child read its answer and publish its result (that turn: `tracking_lost`, unattributed prompt) | A resumed owner with outstanding background work in the bound turn posts `tracking_lost` (phase `unknown`), which a live-owner probe does not repair; the earlier "stale row after `kill -9`" observation is not reproducible today, so a probe-confirmed death may be followed by a respawn |
| Same run: `claude --bg --worktree <name>` | Creates `<root>/.claude/worktrees/<name>` on branch `worktree-<name>`; `claude agents` lists the launch directory for a moment first; `claude rm` removes worktree and branch | `delegate --allow-missing-cwd` lets launchers delegate the final worktree directory before it exists |

`claude-threads` documents further facts verified with Claude desktop 2.16120: model-classified `done`/`blocked`/`working` states, `notify_when_idle` arriving late, and edit refusals in shared checkouts. They informed the phase model and the decision to keep the isolation rule in the skill.

## Revision log

2026-10-04, follow-ups and settlement:

- Codex→Claude live gate passed with real tasks (heartbeat wake 63 s after the result, acknowledgement, self-deletion after the last delegation closed). The same runs showed parent follow-ups never reaching working workers.
- A parent's `send` to the worker of its open delegation joins that correlation. The per-worker Claude hooks add `PostToolUse` and ring a doorbell on it and on `Stop` (see "Mid-task follow-ups"); the hook command keeps stdout for that decision. The contract tells workers to expect follow-ups and to re-read before their result. Verified live with two Haiku workers.
- Migration 004 adds `receipts.settled_reason`. A delegation's terminal transition settles its leftover mail (result: the worker's side; parent close: both sides), and the migration backfills finished delegations, including follow-ups sent before they joined the correlation.
- `delegations --global` lists every parent's delegations without a caller identity, with the parent named.

2026-10-01, milestone 5 (`claude-threads` on Agentbus):

- `claude-threads` launches through `delegate` with labels, launch manifests and locks, the contract plus a `<thread-rules>` isolation rule, per-worker `--settings` and `session bind`; `cleanup.sh` resolves children through `delegations --json` and `rm` closes their delegations. `threads.py`, `wait.sh` and `status.sh` are gone (scripts about 980 → 630 lines); rollback tag `claude-threads-v1-registry` in agent-skills.
- `wait --replace` enforces one watcher per session: a superseded wait exits with `reason: superseded` without claiming mail (checked inside the claiming transaction).
- `delegate --allow-missing-cwd` resolves a directory a launcher creates later (`claude --worktree`) through its nearest existing ancestor, so the contract claim still checks the exact final path.
- `delegations` views carry `worker {externalId, shortId, cwd}` for launcher scripts.
- A Claude `SessionStart source=resume` while the bound turn's background work is outstanding posts `tracking_lost`: the respawned owner does not adopt the previous owner's tasks. Recovery is a provider-native doorbell from the lead.
- Review fixes: a tracking loss recorded by a probe in the respawn window is converted to the permanent orphaned-wait loss on resume; the Claude worker contract arms its wait with `--replace`, so a re-armed wait retires an orphan; a superseded wake tells the consumer not to re-arm. In `claude-threads`: worktree refusal before delegating, key over the resolved directory, reconciliation of interrupted launches (relaunch only when the launcher positively ended and no session of that name started), re-read under the lock, and probe-guarded `cleanup --settled`.

2026-10-01, milestone 4 launchers:

- `codex-to-claude` and `claude-to-codex` are tracked by default (`--no-track` keeps the plain path): keyed `delegate`, launch manifests, request/thread ownership locks, contract appended to the prompt, `session bind`, runner events with durable run IDs and a sanitized worker environment, persisted Desktop-open marker, and the Desktop handoff guard based on `delegations` handoff readiness (latest Stop listed no background tasks or scheduled wakeups; migration 003 records the latter) plus a fresh idle probe.
- Worker settings pre-allow the Agentbus CLI. Workers and hooks run a standalone executable on the internal disk because background sessions can lose read access to external volumes.

2026-10-01, per-worker Claude hooks:

- User-level hook installation became optional. `delegate --to claude` writes a per-worker settings file for `claude --bg --settings`, so Agentbus code runs only in its own workers. Lifecycle observation of a Claude worker is guaranteed while its background owner runs it; after a Desktop handoff it relies on explicit replies and probes, matching the Codex worker scope.

2026-10-01, correctness review:

- Separated release targets from verified primitives; retained live capability gates and manual fallback when wake facilities are absent.
- Made `read --unseen` non-mutating, acknowledgement imply seen, and recovery reads mandatory on every wake. Defined bounded pagination and batch waits that surface attention before settlement.
- Defined role/correlation and terminal-state invariants, one open delegation per worker, and request-intent idempotency independent of generated IDs and later task state.
- Replaced turn/type event deduplication with captured occurrence IDs and durable run/turn bindings. Restricted task-notification inheritance to proven provenance; retained terminal lifecycle evidence after result publication.
- Added spool-only wake recovery, stale-event/probe handling, unknown tracking state, and PID/start-identity checks for both runner and child.
- Required durable launch/resume/handoff ownership and ambiguous-launch reconciliation. Found that the current Codex Desktop helper prints its open flag without persisting it and the spawn script has no cross-run resume lock; these now have explicit implementation gates.
- Narrowed wake fencing claims to what a database can enforce; ambiguous external dispatch is never automatically repeated.

Review evidence: the checkout contains only `PLAN.md`; local launcher scripts and Codex CLI help were inspected without launching sessions. Current [Claude hook documentation](https://code.claude.com/docs/en/hooks#permissionrequest-input) confirms that permission-request payloads lack a tool-use ID; the [Codex JSON event example](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable) omits a native turn ID; the [SQLite WAL documentation](https://www.sqlite.org/wal.html#walreset) supports retaining the rollback-journal choice.

Earlier entries below describe the design at that time; this review supersedes conflicting statements.

2026-10-01, Claude→Claude and `claude-threads`:

- Claude→Claude became a target direction, and milestone 5 migrates `claude-threads` onto Agentbus. The Codex wake adapter moved to milestone 6 and the optional extensions to milestone 7.
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

