# Codex wake capability spike — 2026-10-06

Privacy: identifiers are synthetic and paths are generic.

**Decision: the backend-reachability gate failed on this host. Keep the heartbeat as the supported Codex parent return path; do not implement the wake worker yet.**

This is evidence about the observed Desktop configuration, not a claim that every Codex installation lacks native wake support. Raw command receipts and process evidence are in [codex-wake-2026-10-06.json](codex-wake-2026-10-06.json).

## Environment and ownership

- macOS 15.7.3, arm64.
- Desktop app 26.930.61225, build 13232.
- PATH CLI and Desktop-bundled CLI both report `codex-cli 0.160.1`.
- The probe process's parent is the Desktop-bundled `codex app-server` (PID 93393); that server's parent is the Desktop app (PID 93084). This connects the current chat's tool execution to the observed owner, rather than inferring ownership from saved thread files.
- The owner's command has no `--listen` override. Its stdin/stdout are connected Unix descriptors; `lsof` shows no named Unix listener and no listening TCP socket for that process. This agrees with the documented default stdio transport.
- The default control socket, `/Users/example/.codex/app-server-control/app-server-control.sock`, exists, but connection attempts are refused. File existence is not readiness.

## Probes and receipts

Every command had a 10-second subprocess deadline. All four connection probes exited 1 before a provider receipt, in under 200 ms in the recorded run.

| Probe | Result |
| --- | --- |
| `codex app-server daemon version` | Connection refused at the default control socket |
| `codex app-server proxy` (empty stdin) | Connection refused at the same socket |
| PATH CLI `queue --remote unix://` | Connection refused before thread lookup |
| Bundled CLI `queue --remote unix:///Users/example/.codex/app-server-control/app-server-control.sock` | Same refusal; using the bundled executable and explicit path does not repair reachability |

The queue probes used a nonexistent test UUID (`00000000-0000-4000-8000-000000000001`), never the current or another existing chat. Both failed during transport connection. The exact queue error was:

```text
Error: failed to connect to remote app server: failed to connect to remote app server at `unix:///Users/example/.codex/app-server-control/app-server-control.sock`: Connection refused (os error 61)
```

No daemon was started, no provider configuration changed, and no model session or automation was created. The Desktop app and its owning backend were not restarted or interrupted. The app's private IPC socket was not treated as an App Server endpoint.

## What this establishes

The available CLI control path cannot connect to a running server on this host, while the current chat's owner exposes no observed listener for another client. A second App Server process would be a different owner; its ability to read a stored thread would not prove safe wake-up of the original Desktop chat.

The first capability gate therefore fails. Production dispatch, wake outbox, leases and worker installation remain deferred. Existing durable mailbox delivery and the verified heartbeat workflow remain the supported path.

| Remaining case | State |
| --- | --- |
| Idle, active and hidden Desktop chat delivery | Not run: no reachable owning-backend endpoint |
| Queue acceptance versus a started turn, same native thread | Not run: no provider acceptance |
| Duplicate dispatch and unknown receipt | Not run: connection refusal is a known pre-dispatch failure, not an uncertain accepted dispatch |
| Disconnect/reconnect of a reachable backend | Not run: both clients failed before connection |
| Codex background-terminal completion re-invoking an ended parent turn | Unverified; this is an independent candidate and is not ruled out by the socket failure |

These cases are not passed by the failed preflight. No disposable chat was needed after reachability failed.

## Reproduction and next gate

Inspect the current chat's tool-process ancestry and the owning server's command and listeners. Run `codex app-server daemon version` and `codex app-server proxy` with a 10-second subprocess deadline. Use the exact recorded queue argv from the JSON only against a verified nonexistent test address, with explicit `--remote` so the probe does not request a managed daemon start. Repeat with the Desktop-bundled CLI. Record both exit status and stderr; never infer readiness from a socket file or `queue --help`.

Rerun the delivery cases only when the Desktop owner offers a supported, reachable App Server endpoint, or a supported background-terminal wake path can be exercised in a disposable chat. Prove the endpoint belongs to the original chat's owner before dispatch. Preserve the same thread ID, distinguish queue/start/steer behavior, and retain uncertain outcomes without automatic redispatch.

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server) describes stdio as the default, Unix control sockets as WebSocket transports, and separate `turn/start` and `turn/steer` operations. It does not establish access to this Desktop owner's stdio connection. Documentation checked on 2026-10-06; the host evidence above determines this spike's result.
