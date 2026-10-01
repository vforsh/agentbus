// Protocol vocabulary shared by store, services and commands.

export const ENVELOPE_VERSION = 1;
export const OUTPUT_VERSION = 1;

export const PROVIDERS = ["codex", "claude", "generic"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type AnyProvider = Provider | "system";

export const MESSAGE_TYPES = ["message", "request", "progress", "question", "result", "notice"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const TASK_TYPES: ReadonlySet<MessageType> = new Set(["progress", "question", "result"]);

export const OUTCOMES = ["success", "blocked", "failed", "unknown"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const NOTICE_KINDS = [
  "turn_finished",
  "turn_failed",
  "turn_interrupted",
  "permission_request",
  "tracking_lost",
  "launch_failed",
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** Notices that need the parent's attention before a batch can settle. */
export const ATTENTION_NOTICES: ReadonlySet<string> = new Set([
  "turn_failed",
  "turn_interrupted",
  "permission_request",
  "tracking_lost",
  "launch_failed",
]);

export interface NoticeMeta {
  kind: NoticeKind;
  observationId: string;
  provider: Provider;
  truncated?: boolean;
  originalBytes?: number;
}

export const PHASES = [
  "pending",
  "working",
  "permission",
  "question",
  "idle",
  "interrupted",
  "unknown",
  "done",
  "closed",
] as const;
export type Phase = (typeof PHASES)[number];

export type ReturnPath = "heartbeat" | "background_wait" | "manual";
export type ReturnPathStatus = "setup_required" | "ready" | "unsupported";

/** Bodies above 1 MiB are rejected; batches are bounded at 4 MiB of body text. */
export const BODY_LIMIT = 1024 * 1024;
export const BATCH_BODY_BUDGET = 4 * 1024 * 1024;
export const SUMMARY_LIMIT = 200;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;
export const MAX_LABELS = 16;

export interface Envelope {
  schemaVersion: number;
  id: string;
  sequence: number;
  from: string;
  to: string;
  type: MessageType;
  summary: string | null;
  body: string;
  createdAt: string;
  correlationId: string;
  inReplyTo: string | null;
  idempotencyKey: string | null;
  outcome: Outcome | null;
  notice: NoticeMeta | null;
  turnRef: string | null;
  seenAt: string | null;
  acknowledgedAt: string | null;
}
