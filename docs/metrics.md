# Delivery and backlog metrics

[Back to README](../README.md)

```bash
agentbus metrics                          # caller as parent, all retained history
agentbus metrics --global --since 14d --group-by direction --json
agentbus metrics --global --since 2026-10-19T00:00:00+03:00 \
  --until 2026-10-29T00:00:00+03:00 --project /abs/project --group-by model
agentbus metrics --direction claude:codex --model gpt-6.1-sol --label kind=review
agentbus metrics --plain                  # versioned TSV summary
```

`metrics` opens SQLite read-only and takes one deferred snapshot. It never drains hooks, marks mail
seen, acknowledges it, changes delegation state or calls provider CLIs. Local process checks sample
watcher liveness after the database snapshot. Queued hook events remain outside the report until ingested.

**Selection is a delegation cohort:** `--since` is inclusive and `--until` exclusive, applied to
`delegations.opened_at`. All retained results, answers and receipts of those delegations are included,
including events after `--until`; this is not a historical as-of snapshot. Date-only bounds mean UTC;
ISO timestamps require a timezone. `--since` also accepts positive lookbacks such as `14d` from now.
`--project` selects the worker checkout and descendants, resolving existing symlink aliases and respecting
path boundaries. Use a parent directory to cover several checkouts; deleted paths can still match by
absolute path. `--direction` is `parent:worker`; `--model` is shorthand for the worker's `model` label.
Repeat `--label k=v` to intersect labels. Task kinds are explicit labels, not guesses from task names;
old delegations without that label do not match it.

Default scope is all retained delegations of the caller **as parent**. `--global` skips caller resolution. With no
caller identity, or a native Claude/Codex session that never registered, metrics warn on stderr and report the
global scope instead of failing; an explicit `--as` or `AGENTBUS_SESSION_ID` must still resolve.
Unrelated inbox mail is excluded. `--group-by project|direction|model|label:<key>` adds `groups` with the
same delegation/result/question/follow-up aggregates; missing labels form a null group. Root aggregates
always describe the whole selection. Pruning removes history. Empty selections return zero counts,
null oldest records and null statistics; a missing store exits 4.

JSON keeps the normal `schemaVersion`/`ok`/`data` envelope. **`data.metricsVersion: 2`** identifies the
extended report: `snapshotAt` is UTC ISO, `units` is `ms`, `scope` identifies the parent/global scope,
and `filters` contains normalized bounds, project, direction, labels and grouping.

| Field | Meaning |
| --- | --- |
| `delegations.total`, `withoutResult` | Selected delegations; open/closed without a result |
| `delegations.duration` | Open → terminal transition, including parent-closed work; open work is pending |
| `results.commitToSeen` | Result creation → recorded seen, including ack-inferred and historical seen |
| `results.seenToAck` | Recorded seen → acknowledgement; can be synthetic zero |
| `results.commitToAck` | Result creation → acknowledgement |
| `results.commitToDelivery`, `deliveryToAck` | Independent recorded delivery only; excludes ack-inferred and unknown historical seen |
| `results.seenSources` | Counts of `wait`, `doorbell`, `read`, `ack`, `settlement`, `legacy`, `unseen`, `missing` |
| `results.awaitingSeen`, `awaitingAck` | Pending result counts, unseen count and oldest record |
| `questionResponse` | Question count, answered count, closed-unanswered count, and first parent reply latency |

The commit timestamp approximates publication: `created_at` is captured inside the insertion transaction,
not at SQLite commit completion. Delivery means the page was committed for output, **not proof the
human/model consumed it**. Ordinary `read` stays non-mutating; `read --mark-seen` explicitly records
delivery of its returned page without accepting responsibility, before stdout. `--mark-seen` and `--ack`
are incompatible. Paginate using `hasMore`/`cursor`; recover unacknowledged mail from the beginning on
every wake even if already seen. Lost output remains recoverable with ordinary `read`.

Since schema 7, `receipts.seen_source` records the operation that first set `seen_at` (`seenSource` in
message envelopes). `ack`, `read --ack` and acknowledging replies synthesize source `ack` only when
previously unseen; automatic settlement uses `settlement`. Later operations never overwrite provenance.
Migration leaves historical provenance unknown: equal seen/ack timestamps do not establish how delivery
happened. `legacy` samples remain in the compatibility intervals but are `unobserved` in delivery-only
intervals; their true delivery latency cannot be recovered.

Each distribution has exclusive counts `measured`, `pending`, `missing`, `settled`, `invalid`, `unobserved`,
and `minMs`, `meanMs`, `maxMs`, `p50Ms`, `p90Ms`, `p95Ms` over measured samples. Percentiles use linear
interpolation at `(n−1)×p` (R-7); even-count p50 is the two middle values' midpoint. No samples means null,
not zero. `unobserved` excludes seen without independent delivery evidence; `settled` excludes automatic
receipt settlement or a closed unanswered question. Malformed/reversed intervals are invalid. These are
wall-clock durations, not model CPU time or cost; clock corrections can invalidate samples.

`questions` and `followups` remain active backlogs: `{count, unseen, oldest}`. Oldest records contain
`messageId`, `requestId`, `parentId`, `workerId`, `createdAt`, `ageMs` (future age clamps to zero).
A question remains unanswered until the parent replies to that exact ID; ack alone does not answer it.
`questionResponse` includes answered questions from terminal delegations too. Parent-to-worker follow-ups
include answers and exclude the initial request; seen without ack stays pending. Result/close removes
terminal leftovers from active backlogs, without pretending unanswered questions received an answer.

Without cohort filters, wait counts retain their original scope: all waits of the parent and delegated
workers, or every session for `--global`. With filters, waits must belong to a selected parent/worker,
match any recorded correlation and overlap its lifetime. A broad wait covering several
selected delegations counts once. Group aggregates omit watcher counts because one arm may cover
several groups.

`watchers` measures **wait arms**, not app heartbeat scheduling. `total` includes ended history; `ended`
arms are not stale. Each unended arm appears in `items` with scope, correlation, timestamps, age,
`processLiveness`/`ownerLiveness` (`alive|dead|unknown`), state and independent `expired`/`stale` flags.
`live`, `dead`, `ownerLost`, `unverified` partition unended arms. Death requires a successful local
process check proving the recorded PID/start identity absent or replaced. Owner lost means the wait
itself is alive and at least one recorded ancestor is confirmed dead. Missing identity, no owner evidence
or a failed process check is unverified, never proof of death. Filtered waits count as live when verified,
but their `scope` does not promise full delivery coverage; use `delegations`/`explain` for readiness.

`expired` means now reached `expires_at` (no grace); pre-v6 arms fall back to `created_at + MAX_WAIT_MS`
(24 hours), exposed as `effectiveExpiresAt`. `stale` is the union of expired, dead and owner lost arms,
**not a dead count**. These counts overlap: an expired arm can still be live or unverified. In contrast,
return-path readiness allows a 60-second expiry grace. A normal timeout records an ended arm and does
not prove process death. Heartbeat freshness remains a parent report shown by `delegations`/`explain`.

TSV: `metricsVersion` → 2. Columns: `snapshot` → timestamp, unit, scope, parent ID; `delegations` → total, without result;
`latency` → interval, measured, pending, missing, settled, invalid, min, mean, max, p50, p90, p95, unobserved;
`backlog` → name, count, unseen, oldest message ID, oldest age;
`watchers` → total, ended, unended, live, dead, owner lost, unverified, expired, stale.
Additional TSV rows: `filters` → normalized JSON; `seenSource` → source, count; `questionResponse` → total, answered, closed unanswered; `group` → field, JSON value, aggregate JSON. Missing TSV values use `-`. JSON watcher items grow with unended waits; retained history is scanned
locally on demand, without a telemetry service or scheduler.
