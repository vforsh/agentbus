// Error contract: every failure carries a stable code, an exit code and payload-free details.

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  timeout: 3,
  notFound: 4,
  conflict: 5,
  busy: 6,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class AgentbusError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, exitCode: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AgentbusError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export const usageError = (message: string, details: Record<string, unknown> = {}) =>
  new AgentbusError("invalid_usage", message, EXIT.usage, details);

export const inputError = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new AgentbusError(code, message, EXIT.usage, details);

export const notFound = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new AgentbusError(code, message, EXIT.notFound, details);

export const conflict = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new AgentbusError(code, message, EXIT.conflict, details);

export const failure = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new AgentbusError(code, message, EXIT.failure, details);

/** SQLite reports contention as SQLITE_BUSY/SQLITE_LOCKED; surface it as exit 6. */
export function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))) {
    return true;
  }
  return /database is locked|database table is locked/i.test(err.message);
}

export function toAgentbusError(err: unknown): AgentbusError {
  if (err instanceof AgentbusError) return err;
  if (isBusyError(err)) {
    return new AgentbusError(
      "database_busy",
      "The mailbox database stayed locked past the busy deadline; retry the command",
      EXIT.busy,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AgentbusError("unexpected_error", message, EXIT.failure);
}
