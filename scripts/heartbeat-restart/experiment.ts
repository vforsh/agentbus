// Opt-in experiment only: public CLI subprocesses, isolated store, synthetic mailbox producers.
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type BuildInfo, checkoutBuildInfo } from "../../src/build-info.ts";
import { shellQuote } from "../../src/config/config.ts";
import type { Envelope } from "../../src/protocol/types.ts";
import { writeFileAtomic } from "../../src/util/fsx.ts";
import { ROOT } from "../build.ts";
import { automationData, captureHost, type HostEvidence, restarted, toolData } from "./host.ts";

interface Worker {
  workerId: string;
  requestId: string;
}
interface Batch {
  messages: Envelope[];
  cursor: number | null;
  hasMore: boolean;
}
export interface Experiment {
  schemaVersion: 1;
  id: string;
  mode: "fixture" | "live";
  threadId: string;
  parent: string;
  dir: string;
  stateDir: string;
  config: string;
  cli: string[];
  createdAt: string;
  deadline: string;
  before: HostEvidence | null;
  build: BuildInfo;
  automationId: string | null;
  bindingCheckedAt: string | null;
  restart: HostEvidence | null;
  workers: { seen: Worker; pending: Worker; guard: Worker };
  results: { seen: string; pending: string; guard?: string };
  expected: string[];
  cleanup: "pending" | "ready" | "complete" | "aborted";
}

export function load(dir: string): Experiment {
  const m = JSON.parse(readFileSync(join(resolve(dir), "experiment.json"), "utf8")) as Experiment;
  if (m.schemaVersion !== 1 || m.dir !== resolve(dir) || m.stateDir !== join(m.dir, "state")) {
    throw new Error("Invalid experiment manifest or moved directory");
  }
  return m;
}

function save(m: Experiment): void {
  writeFileAtomic(join(m.dir, "experiment.json"), `${JSON.stringify(m, null, 2)}\n`, 0o600);
}

/** SQLite serializes handlers and releases the OS lock even on SIGKILL; no stale lease race. */
export function exclusive<T>(dir: string, action: () => T): T {
  const path = join(resolve(dir), "handler-lock.sqlite3");
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("BEGIN IMMEDIATE");
    return action();
  } finally {
    db.close();
  }
}

export function record(m: Experiment, kind: string, data: unknown): void {
  writeFileSync(
    join(m.dir, "receipts", `${Date.now()}-${crypto.randomUUID()}-${kind}.json`),
    JSON.stringify({ kind, at: new Date().toISOString(), data }, null, 2),
    { mode: 0o600, flag: "wx" },
  );
}

function identity(m: Experiment): void {
  if (m.mode === "live" && process.env.CODEX_THREAD_ID !== m.threadId) {
    throw new Error(`Original-chat mismatch: expected CODEX_THREAD_ID=${m.threadId}; no refresh or ack`);
  }
}

export function bus<T>(m: Experiment, args: string[], as = m.parent, input?: string, exits = [0]): T {
  const env = { ...process.env };
  for (const k of [
    "CODEX_THREAD_ID",
    "CLAUDE_CODE_SESSION_ID",
    "AGENTBUS_SESSION_ID",
    "AGENTBUS_CONFIG",
    "AGENTBUS_STATE_DIR",
    "AGENTBUS_FAULT_INJECT",
  ])
    delete env[k];
  env.XDG_DATA_HOME = join(m.dir, "data");
  const argv = [...m.cli, "--config", m.config, "--state-dir", m.stateDir, "--as", as, "--json", ...args];
  const r = Bun.spawnSync(argv, {
    cwd: m.dir,
    env,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const receipt = JSON.parse(r.stdout.toString()) as { ok: boolean; data: T; error?: unknown };
  record(m, "cli", { argv, exit: r.exitCode, receipt, stderr: r.stderr.toString() });
  if (!exits.includes(r.exitCode) || !receipt.ok) throw new Error(`CLI failed: ${JSON.stringify(receipt)}`);
  return receipt.data;
}

/** Every sweep starts at the oldest unacknowledged receipt; cursors exist only within this sweep. */
export function sweep(m: Experiment): { messages: Envelope[]; pages: number } {
  const messages: Envelope[] = [];
  let cursor: number | null = null;
  let pages = 0;
  while (true) {
    const batch: Batch = bus(m, ["read", ...(cursor === null ? [] : ["--after", String(cursor)])]);
    pages++;
    messages.push(...batch.messages);
    if (!batch.hasMore) return { messages, pages };
    if (batch.cursor === null || batch.cursor <= (cursor ?? 0))
      throw new Error("Recovery cursor did not advance");
    cursor = batch.cursor;
  }
}

function publish(m: Experiment, w: Worker, key: string, type: "result" | "message", body: string) {
  return bus<{ messageId: string; duplicate: boolean }>(
    m,
    [
      "reply",
      w.requestId,
      "--type",
      type,
      ...(type === "result" ? ["--outcome", "success"] : []),
      "--key",
      key,
      "--file",
      "-",
    ],
    w.workerId,
    body,
  );
}

export function prepare(dir: string, mode: Experiment["mode"], threadId: string, filler = 51): Experiment {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId))
    throw new Error("Invalid thread UUID");
  dir = resolve(dir);
  if (existsSync(dir)) throw new Error("Choose a new experiment directory; existing paths are never reused");
  if (mode === "live" && process.env.CODEX_THREAD_ID !== threadId)
    throw new Error("Prepare from the original native chat");
  const before = mode === "live" ? captureHost() : null;
  mkdirSync(dirname(dir), { mode: 0o700, recursive: true });
  mkdirSync(dir, { mode: 0o700 });
  for (const sub of ["receipts", "handled"]) mkdirSync(join(dir, sub), { mode: 0o700 });
  const cli = [process.execPath, join(ROOT, "src/main.ts")];
  const m: Experiment = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    mode,
    threadId,
    parent: `codex:${threadId}`,
    dir,
    stateDir: join(dir, "state"),
    config: join(dir, "config.json"),
    cli,
    createdAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
    before,
    build: checkoutBuildInfo(ROOT),
    automationId: null,
    bindingCheckedAt: null,
    restart: null,
    workers: {
      seen: { workerId: "", requestId: "" },
      pending: { workerId: "", requestId: "" },
      guard: { workerId: "", requestId: "" },
    },
    results: { seen: "", pending: "" },
    expected: [],
    cleanup: "pending",
  };
  writeFileSync(
    m.config,
    JSON.stringify({
      cliCommand: cli.map(shellQuote).join(" "),
      claudeBin: join(dir, "no-claude"),
      codexBin: join(dir, "no-codex"),
      claudeSettingsPath: join(dir, "claude-settings.json"),
      claudeJobsDir: join(dir, "jobs"),
    }),
    { mode: 0o600 },
  );
  m.build = bus(m, ["build-info"]);
  bus(m, ["init"]);
  bus(m, [
    "session",
    "register",
    "--provider",
    "codex",
    "--external-id",
    threadId,
    "--name",
    "restart-experiment",
  ]);
  for (const name of ["seen", "pending", "guard"] as const) {
    const delegation = bus<Worker>(
      m,
      ["delegate", "--to", "codex", "--name", name, "--key", `task-${name}`, "--file", "-"],
      m.parent,
      `Synthetic ${name}; no provider process is launched.`,
    );
    m.workers[name] = { workerId: delegation.workerId, requestId: delegation.requestId };
    bus(m, ["ack", m.workers[name].requestId], m.workers[name].workerId);
  }
  m.results.seen = publish(
    m,
    m.workers.seen,
    "result",
    "result",
    "Seen result — проверка recovery",
  ).messageId;
  bus(m, ["wait", "--replace", "--correlation", m.workers.seen.requestId, "--timeout", "1ms"]);
  // Worker messages, not progress: a result settles its delegation's progress, and the filler must stay
  // pending to force a multi-page recovery scan.
  for (let i = 0; i < filler; i++)
    m.expected.push(
      publish(m, m.workers.pending, `message-${i}`, "message", `Synthetic message ${i}`).messageId,
    );
  m.results.pending = publish(
    m,
    m.workers.pending,
    "result",
    "result",
    "Unread result — quotes '$()' `literal`",
  ).messageId;
  m.expected.push(m.results.seen, m.results.pending);
  const baseline = sweep(m);
  const seen = baseline.messages.find((x) => x.id === m.results.seen)!;
  const pending = baseline.messages.find((x) => x.id === m.results.pending)!;
  if (!seen.seenAt || seen.acknowledgedAt || pending.seenAt || pending.acknowledgedAt)
    throw new Error("Invalid prepared receipts");
  record(m, "prepared-mail", baseline);
  save(m);
  writeFileAtomic(join(dir, "heartbeat-prompt.txt"), prompt(m), 0o600);
  writeFileAtomic(join(dir, "continuation.md"), continuation(m), 0o600);
  return m;
}

export function checkAutomation(m: Experiment, receipt: unknown): void {
  if (m.mode === "live") {
    const bundle = receipt as Record<string, unknown>;
    if (
      bundle.source !== "supported_view_and_read_only_config" ||
      Date.now() - Date.parse(String(bundle.observedAt)) > 60_000 ||
      !Number.isFinite(Date.parse(String(bundle.observedAt)))
    )
      throw new Error(
        "Live view needs fresh supported-tool and read-only config evidence; a fixture receipt is insufficient",
      );
    if (!m.automationId) throw new Error("Record the supported creation receipt first");
  }
  const a = automationData(receipt);
  const target = a.targetThreadId ?? a.target_thread_id;
  if (
    !a.id ||
    a.kind !== "heartbeat" ||
    a.status !== "ACTIVE" ||
    target !== m.threadId ||
    a.prompt !== prompt(m)
  ) {
    throw new Error(
      "Automation must be active, be a heartbeat, target the original chat, and carry the saved prompt",
    );
  }
  if (m.automationId && m.automationId !== a.id)
    throw new Error("Different automation ID; reconcile instead of duplicating");
  m.automationId = String(a.id);
}

export function created(m: Experiment, receipt: unknown): void {
  identity(m);
  const data = toolData(receipt);
  if (
    data.mode !== "create" ||
    data.status !== "ACTIVE" ||
    typeof data.automationId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(data.automationId)
  )
    throw new Error("Expected this experiment's successful heartbeat creation receipt");
  if (m.automationId && m.automationId !== data.automationId)
    throw new Error("Creation ID changed; reconcile instead of creating another heartbeat");
  m.automationId = data.automationId;
  record(m, "automation-created", receipt);
  save(m);
}

/** Current app view is card-only on the observed version. Config is corroboration, not live readiness. */
export function captureView(m: Experiment, toolReceipt: unknown, fixtureConfig?: string): string {
  identity(m);
  if (fixtureConfig && m.mode !== "fixture") throw new Error("Config fixture is fixture-only");
  if (m.mode === "fixture" && !fixtureConfig)
    throw new Error("Fixture capture needs an isolated config file");
  if (!m.automationId || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(m.automationId))
    throw new Error("Record creation first");
  const raw = toolReceipt as { isError?: boolean; content?: { type: string; text?: string }[] };
  if (
    raw.isError ||
    !raw.content?.some((b) => b.type === "text" && b.text === "Rendered automation card in the app.")
  )
    throw new Error("Expected the successful supported automation view receipt");
  const configPath =
    fixtureConfig ??
    join(
      process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      "automations",
      m.automationId,
      "automation.toml",
    );
  // This is the read-only lookup documented by automation_update. Never write app-owned files.
  const automation = Bun.TOML.parse(readFileSync(configPath, "utf8"));
  const bundle = {
    source: "supported_view_and_read_only_config",
    observedAt: new Date().toISOString(),
    request: { mode: "view", id: m.automationId },
    toolReceipt,
    configPath,
    automation,
  };
  checkAutomation(m, bundle);
  const path = join(m.dir, "automation-evidence.json");
  writeFileAtomic(path, `${JSON.stringify(bundle, null, 2)}\n`, 0o600);
  record(m, "automation-evidence", bundle);
  return path;
}

export function bind(m: Experiment, receipt: unknown): void {
  identity(m);
  checkAutomation(m, receipt);
  record(m, "automation-bound", receipt);
  bus(
    m,
    ["session", "update", m.parent, "--binding-file", "-"],
    m.parent,
    JSON.stringify({
      strategy: "heartbeat",
      status: "setup_required",
      handle: m.automationId,
      interval: "5m",
      reason: "Saved automation verified; awaiting original-chat check-in",
    }),
  );
  save(m);
}

export function tick(m: Experiment, receipt: unknown, interruptAfterHandle = false) {
  identity(m);
  if (m.cleanup === "complete" || m.cleanup === "aborted") throw new Error("Experiment already cleaned up");
  checkAutomation(m, receipt);
  record(m, "automation-view", receipt);
  const host = m.mode === "live" ? captureHost() : null;
  if (host && m.before && !m.restart && restarted(m.before, host)) m.restart = host;
  bus(
    m,
    ["session", "update", m.parent, "--binding-file", "-"],
    m.parent,
    JSON.stringify({
      strategy: "heartbeat",
      status: "ready",
      handle: m.automationId,
      interval: "5m",
    }),
  );
  m.bindingCheckedAt = new Date().toISOString();
  record(m, "check-in", {
    nativeThreadId: process.env.CODEX_THREAD_ID ?? null,
    host,
    restartObserved: !!m.restart,
  });
  save(m);
  if (m.mode === "live" && !m.restart)
    return { awaitingRestart: true, expired: Date.now() >= Date.parse(m.deadline), cleanupReady: false };
  const batch = sweep(m);
  record(m, "recovery", batch);
  for (const message of batch.messages) {
    if (!m.expected.includes(message.id) && message.correlationId !== m.workers.guard.requestId)
      throw new Error("Unexpected mail; refusing synthetic handler");
    const path = join(m.dir, "handled", `${message.id}.json`);
    const body = JSON.stringify({
      id: message.id,
      body: message.body,
      type: message.type,
      outcome: message.outcome,
    });
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== body) throw new Error("Handled message intent changed");
    } else {
      // Atomic durable sentinel represents a keyed side effect; retry reuses it before acknowledging.
      writeFileAtomic(path, body, 0o600);
    }
    if (interruptAfterHandle) throw new Error("Injected interruption after handling, before acknowledgement");
    bus(m, ["ack", message.id]);
  }
  const remaining = sweep(m);
  const { delegations } = bus<{ delegations: { state: string }[] }>(m, ["delegations", "--all"]);
  const cleanupReady =
    remaining.messages.length === 0 &&
    delegations.every((d) => d.state !== "open") &&
    m.expected.every((id) => existsSync(join(m.dir, "handled", `${id}.json`)));
  m.cleanup = cleanupReady ? "ready" : "pending";
  save(m);
  return { awaitingRestart: false, recovered: batch.messages.length, pages: batch.pages, cleanupReady };
}

export function finishWorker(m: Experiment): void {
  identity(m);
  if (m.mode === "live" && !m.restart) throw new Error("Awaiting actual app restart");
  if (sweep(m).messages.some((msg) => msg.correlationId !== m.workers.guard.requestId))
    throw new Error("Recover first; guard proves cleanup cannot precede handling");
  if (m.expected.some((id) => id !== m.results.guard && !existsSync(join(m.dir, "handled", `${id}.json`))))
    throw new Error("A receipt was acknowledged without durable handling; investigate before cleanup");
  const r = publish(m, m.workers.guard, "result", "result", "Synthetic guard finished after recovery");
  m.results.guard = r.messageId;
  if (!m.expected.includes(r.messageId)) m.expected.push(r.messageId);
  record(m, "guard-finished", r);
  save(m);
}

export function cleanup(m: Experiment, receipt: unknown, abort = false): void {
  identity(m);
  const data = toolData(receipt);
  const deletedId = data.automationId ?? data.id;
  const deleted = data.deleteStatus === "deleted" || data.deleted === true;
  if (deletedId !== m.automationId || !deleted)
    throw new Error("Save the successful deletion receipt for this experiment's automation");
  if (!abort && m.cleanup !== "ready" && m.cleanup !== "complete")
    throw new Error("Cleanup requires all delegations ended and all mail handled");
  if (abort) {
    // Only this disposable store is changed. An aborted live experiment never earns acceptance.
    for (const w of Object.values(m.workers)) bus(m, ["close", w.requestId]);
    for (const msg of sweep(m).messages) bus(m, ["ack", msg.id]);
  }
  bus(
    m,
    ["session", "update", m.parent, "--binding-file", "-"],
    m.parent,
    JSON.stringify({
      strategy: "heartbeat",
      status: "setup_required",
      handle: null,
      reason: abort
        ? "Restart experiment aborted; own automation deleted"
        : "Experiment complete; own automation deleted",
    }),
  );
  record(m, "automation-deleted", receipt);
  m.cleanup = abort ? "aborted" : "complete";
  save(m);
}

export function status(m: Experiment) {
  return {
    experimentId: m.id,
    mode: m.mode,
    threadId: m.threadId,
    automationId: m.automationId,
    createdAt: m.createdAt,
    deadline: m.deadline,
    before: m.before,
    restart: m.restart,
    cleanup: m.cleanup,
    handled: readdirSync(join(m.dir, "handled")).length,
    pending: sweep(m).messages.length,
    acceptance: m.mode === "fixture" ? "fixture_only" : "requires_live_receipt_review",
  };
}

function prompt(m: Experiment): string {
  const command = [process.execPath, join(ROOT, "scripts/heartbeat-restart.ts")].map(shellQuote).join(" ");
  const d = shellQuote(m.dir);
  return `Continue the authorized Agentbus heartbeat restart experiment ${m.id} in its original chat ${m.threadId}. Read ${join(m.dir, "continuation.md")} first. Verify CODEX_THREAD_ID equals ${m.threadId}; stop without refreshing or acknowledging if it differs. Use automation_update view for this experiment's saved automation ID in experiment.json and save the full JSON tool receipt to ${join(m.dir, "automation-view.json")}. Run ${command} capture-view --dir ${d} --receipt ${shellQuote(join(m.dir, "automation-view.json"))}, then ${command} tick --dir ${d} --receipt ${shellQuote(join(m.dir, "automation-evidence.json"))}. The current view API renders a card; capture-view reads its configuration only as corroboration, never as proof of scheduler liveness. If awaitingRestart is true, stay silent and leave the prepared mail unacknowledged. Do not restart the app or interrupt other chats. If expired, delete only this experiment's automation using automation_update, save its full deletion receipt to automation-delete.json here, and run ${command} cleanup --abort --dir ${d} --receipt ${shellQuote(join(m.dir, "automation-delete.json"))}; report the unverified restart gate once. After an observed restart, tick handles synthetic mail with durable per-message sentinels before ack. If cleanupReady is false, run ${command} finish-worker --dir ${d}, then tick again with the same fresh evidence; delete the automation only after cleanupReady is true. Save the full deletion tool receipt to automation-delete.json and run ${command} cleanup --dir ${d} --receipt ${shellQuote(join(m.dir, "automation-delete.json"))}. Then record supported read_thread evidence for this original chat and update docs/live/heartbeat-restart-2026-10-06.md with timings and receipts. A CLI process restart or fixture evidence never passes the Desktop restart gate. Stay quiet unless recovery completes, fails, expires, or requires user action. Do not edit private app state, create another automation/chat, or start provider workers.`;
}

function continuation(m: Experiment): string {
  return `# Restart experiment ${m.id}\n\nOriginal chat: ${m.threadId}. Mode: ${m.mode}. State/config are inside this directory; synthetic workers never launch a model. Save all supported app API receipts here. Prepared at ${m.createdAt}; expires ${m.deadline}.\n\nBefore restarting: create one chat heartbeat with heartbeat-prompt.txt through automation_update, save its full creation receipt and run created. View it, save the full view receipt and run capture-view, then bind using automation-evidence.json. The observed view API renders a card without metadata; capture-view combines that receipt with a read-only automation.toml snapshot. That snapshot verifies persisted configuration only, not execution or restart resumption. Confirm targetThreadId, kind, ACTIVE status and prompt. Save a fresh list_threads receipt; if any unrelated local chat is active, defer the restart. Never stop another chat.\n\nOnce safe, end the current turn; quit the Desktop app normally and reopen the same app (${m.before?.appPath ?? "fixture: no Desktop restart"}). Do not start a separate app-server. The saved heartbeat supplies continuation; keep the machine awake and app open for at least two schedule intervals. Do not manually tick or send a chat message to claim automatic resumption.\n\nEach scheduled run views the same automation, captures fresh evidence and invokes tick from the original native chat. Mail stays pending until a new Desktop app identity is observed and the recorded old app identity is confirmed dead. After recovery, the open guard proves cleanup must wait; finish-worker then tick supplies the last result. Delete only the saved automation ID; retain the deletion receipt, then cleanup invalidates readiness immediately. Repeating cleanup is safe.\n\nA passed live gate needs pre/post supported automation view receipts plus persisted snapshots (same ID and target), old/new app PID and start identities, a supported original-chat scheduled-turn read_thread receipt after restart, read/ack receipts for both prepared results, at least two recovery pages, one sentinel per handled message across a retry, guard-before/final cleanup receipts, versions and elapsed times. The harness reports requires_live_receipt_review, never live_passed. Fixture runs are separate and can never prove scheduling or Desktop persistence. No restart catch-up guarantee is documented.\n\nIf the deadline expires without a restart, delete this experiment's automation and cleanup --abort, retaining the evidence and reporting acceptance unverified. To cancel immediately, do the same. Never prune or delete another store or automation. See ${join(ROOT, "docs/heartbeat-restart.md")} for exact commands and the API/file boundary.\n`;
}
