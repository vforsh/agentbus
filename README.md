# agentbus

Durable local mailbox for delegating work between Codex and Claude Code sessions.

A parent session delegates a task to a worker; the worker's progress, questions and result come back to the parent's inbox. Every message is committed to SQLite before a receipt is printed and stays recoverable until acknowledged — nothing gets lost when a session dies, restarts or forgets to check.

- **Delegate** to `claude` or `codex` with one command; the worker gets a generated contract telling it how to reply.
- **Wake up** on results: Claude parents arm a background `wait`, Codex parents use an app heartbeat.
- **Follow up** mid-task: Claude workers get new mail through a hook "doorbell"; `success` is refused until follow-ups are handled.
- **See** what's going on: `delegations`, `explain` and `metrics` show phase, stuck work and delivery latency.

## Install

Requires [Bun](https://bun.sh) ≥ 1.4.2; developed and tested on macOS.

```bash
bun add -g @vforsh/agentbus
```

```bash
agentbus upgrade
```

```bash
agentbus init && agentbus doctor
```

`upgrade` builds, smoke-tests and installs the standalone executable workers run, on the internal disk (background workers can't read external volumes). Re-run it after every update, with no workers running. From a checkout, use `bun install && bun run upgrade` instead. Details: [docs/install.md](docs/install.md).

## Quick start

```bash
# Parent
agentbus session register --provider claude --external-id "$CLAUDE_CODE_SESSION_ID" --name lead
agentbus delegate --to codex --name executor --cwd ~/dev/project --key task-002 --file request.md --json
agentbus wait --ensure --timeout 30m --probe 60s --json   # run in the background

# Worker (commands come from its <agentbus-contract> block)
<worker-bin> read --correlation <request-id>
<worker-bin> reply <request-id> --type result --outcome success --key result-1 \
  --summary "Parser fixed; tests pass" --file result.md

# Parent, mid-task or after waking
agentbus followup executor --summary "Use the staging DB" --file followup.md
agentbus take                 # results and questions in full, plus next steps
agentbus explain executor     # timeline and why it's stuck
```

Agents should load the bundled skill instead: [skill/agentbus/SKILL.md](skill/agentbus/SKILL.md).

## Docs

| Doc | What's in it |
| --- | --- |
| [CLI reference](docs/cli.md) | Every command, flag semantics, exit codes |
| [Protocol](docs/protocol.md) | Envelope, roles, delivery, return paths, support matrix |
| [Install & upgrade](docs/install.md) | Locations, offline upgrades and recovery, Claude hooks, config |
| [Metrics](docs/metrics.md) | `agentbus metrics` cohorts, fields and TSV format |
| [Verification](docs/verification.md) | Milestone status, `bun run gate`, live checks |
| [PLAN.md](PLAN.md) · [History](docs/history.md) | Design rationale and how it got here |

## Development

```bash
bun run gate
```

Lint, typecheck, integration, e2e and compiled release checks against temporary stores; never touches `~/.claude` or the real mailbox.

## License

[MIT](LICENSE). Fixtures and recorded evidence use synthetic identifiers and generic paths.
