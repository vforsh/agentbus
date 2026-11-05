# CLI reference

[Back to README](../README.md). Every command has `--help`.

## Commands

```text
agentbus init | whoami | build-info | upgrade | doctor|check | skill | completion <fish|zsh|bash>
agentbus session register|bind|list|show
agentbus session update <session> [--name] [--label k=v]... [--binding-file <path|->|--refresh]
agentbus delegate --to <claude|codex> --file <path|-> [--name] [--cwd] [--allow-missing-cwd] [--key] [--summary] [--label k=v]... [--contract-out] [--dry-run]
agentbus delegations [<request-id|name>...] [--all] [--global] [--probe]
agentbus send <recipient> --file <path|-> [--type message|request] [--key] [--summary] [--dry-run]
agentbus followup <request-id|name> --file <path|-> [--key] [--summary] [--dry-run]
agentbus reply <message-id> --file <path|-> [--type message|progress|question|result] [--outcome] [--key] [--summary] [--no-ack]
agentbus show <message-id>
agentbus read [--ack|--mark-seen] [--all] [--unseen] [--after <seq>] [--from] [--type] [--correlation] [--limit]
agentbus take [<request-id|name>] [--peek]
agentbus ask --file <path|-> [--summary] [--timeout 30m] [--no-wait]                 # worker
agentbus finish --file <path|-> [--outcome success|blocked|failed|unknown] [--summary]  # worker
agentbus wait [--timeout 60s] [--settled] [--probe <interval>] [--replace|--ensure] [--after] [--from] [--type] [--correlation] [--limit]
agentbus ack <message-id...> | close <request-id|name>
agentbus status [<session>] [--probe]
agentbus metrics [--global] [--since <date|duration>] [--until <date>] [--project <dir>] [--direction <parent:worker>] [--model <model>] [--label k=v]... [--group-by <field>]
agentbus explain <request-id|name> [--global] [--probe] [--limit 40]
agentbus event ingest --provider claude --source hook        # stdin, silent; used by hooks
agentbus event ingest --provider codex --source runner --file <event.json>
agentbus event drain
agentbus prune [--older-than <duration>] [--dry-run]   # default: config pruneOlderThan, else 7d
agentbus hooks claude print|install|uninstall|status [--dry-run]
agentbus config|cfg list|ls|path|get|set|unset|import|export
```

Global: `--as`, `--config`, `--state-dir`, `--json`, `--plain`, `-q`, `-v`, `--no-color`, `--no-input`, `--version`, `-h`.

## Semantics

For agents and humans, `read` prints readable bodies; `show <id>` prints one full body, including acknowledged mail (sender or recipient only). Use `--json` for scripts. Replies acknowledge their source in the same transaction; `--no-ack` opts out. Failed replies and dry runs leave receipts unchanged. Keyed retries can acknowledge the source without sending another reply; opting out never reverses an existing acknowledgement or delegation settlement.

`take` is the parent's one-call collection: new mail of the caller's delegations (or one, by request ID or worker name), grouped per delegation with the result and messages in full, unanswered questions, notices and the latest progress while no result exists, followed by `Next:` steps. It acknowledges everything it shows except questions, which `reply` acknowledges with the answer; `--peek` acknowledges nothing. Like `read --ack`, it commits before printing.

`ask` and `finish` are the worker's verbs; both resolve the caller's delegation. `ask` posts one question (keyed, so re-running never posts twice and a different question while one is open is refused) and waits on that request for any unacknowledged parent mail, including mail the doorbell already marked seen; it prints the answer and any follow-ups in full, acknowledges them before printing, and exits 3 on timeout. An answer acknowledged by an earlier run is shown again without waiting. `--no-wait` only posts. `finish` publishes the one result (keyed); for a `success` it first shows unacknowledged parent mail in full with the `ack` command to run (exit 5, nothing published). A changed result after publication is refused (exit 5, `delegation_closed`).

`reply` without `--key` derives one for task replies and answers (see [protocol](protocol.md)); JSON receipts show it as `key`.

`wait --ensure` returns at once (exit 0, `reason: already_watched`, the covering `watcher`) when a live wait of the session already covers its mail (for example one owned by the agentbus-threads mod); otherwise it waits like a plain `wait`. It never retires another wait and cannot be combined with `--replace`, `--settled`, `--from` or `--type`.

An option that belongs to a different command (`read --timeout`) fails with usage exit 2 and names the commands that accept it.

Batch `ack <id>…` after handling results. `read --ack` accepts only the returned, filtered page and preserves pagination. It commits acknowledgement before printing, so use it only when accepting that batch: a lost stdout does not undo acceptance; recover its bodies with `read --all` or `show`.

The companion `claude-threads` launcher provides `cleanup.sh cancel <name|request-id>` (stop the owner, close the delegation, keep the session). The `agentbus-threads` mod previews question/result bodies and supports opt-in `stop_when_settled`, which stops idle child owners after their result is acknowledged and background work has ended.

## Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Success (for `send`, the message is committed) |
| 1 | Unexpected failure; `doctor` not ready; `hooks claude status` not current |
| 2 | Invalid usage or input (bad flags, >1 MiB body, malformed UTF-8) |
| 3 | `wait` timed out: empty list, `timedOut: true`; run the recovery `read` anyway |
| 4 | Session, message, delegation or store not found |
| 5 | Conflict: retry key reuse, ambiguous identity, wrong role/recipient, closed delegation (including a late `followup` or answer), `success` with unacknowledged follow-ups (`followups_pending`), busy worker, binding conflict |
| 6 | Database busy past the deadline (5 s for commands, 1 s for hooks) |
| 130 | Interrupted |

`--json` prints exactly one `{"schemaVersion":1,"ok":...}` object per invocation, including failures.
