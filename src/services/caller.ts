import { AgentbusError, EXIT, usageError } from "../errors.ts";
import type { Db } from "../store/db.ts";
import { resolveAddress, type SessionRow } from "../store/sessions.ts";

export type CallerSource = "flag" | "env" | "native";

export interface CallerRef {
  address: string;
  source: CallerSource;
  detail: string;
}

/**
 * Caller resolution, first match wins: --as, AGENTBUS_SESSION_ID, then native provider markers.
 * Native detection refuses to guess when markers from more than one provider are present.
 */
export function resolveCallerRef(asFlag: string | undefined): CallerRef | null {
  if (asFlag) return checkNotSystem({ address: asFlag, source: "flag", detail: "--as" });
  const env = process.env.AGENTBUS_SESSION_ID;
  if (env) return checkNotSystem({ address: env, source: "env", detail: "AGENTBUS_SESSION_ID" });
  const claude = process.env.CLAUDE_CODE_SESSION_ID;
  const codex = process.env.CODEX_THREAD_ID;
  if (claude && codex) {
    throw new AgentbusError(
      "ambiguous_identity",
      "Both CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID are set; pass --as or AGENTBUS_SESSION_ID explicitly",
      EXIT.conflict,
    );
  }
  if (claude) return { address: `claude:${claude}`, source: "native", detail: "CLAUDE_CODE_SESSION_ID" };
  if (codex) return { address: `codex:${codex}`, source: "native", detail: "CODEX_THREAD_ID" };
  return null;
}

function checkNotSystem(ref: CallerRef): CallerRef {
  if (ref.address.startsWith("system:") || ref.address === "00000000-0000-4000-8000-000000000000") {
    throw usageError("The system observer is reserved and cannot be selected as a caller");
  }
  return ref;
}

export interface Caller {
  ref: CallerRef;
  session: SessionRow;
}

/** Mutating commands require a registered caller. */
export function requireCaller(db: Db, asFlag: string | undefined): Caller {
  const ref = resolveCallerRef(asFlag);
  if (!ref) {
    throw usageError(
      "Cannot determine the calling session: pass --as <address>, set AGENTBUS_SESSION_ID, or run inside a Claude/Codex session",
    );
  }
  const session = resolveAddress(db, ref.address);
  if (!session) {
    throw new AgentbusError(
      "caller_not_registered",
      `Caller ${ref.address} (from ${ref.detail}) is not registered; run \`agentbus session register\``,
      EXIT.notFound,
      { address: ref.address, source: ref.source },
    );
  }
  if (session.provider === "system") throw usageError("The system observer cannot act as a caller");
  return { ref, session };
}
