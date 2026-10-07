import { type Liveness, livenessAll, type ProcessIdentity } from "../adapters/process.ts";
import { MAX_WAIT_MS } from "../protocol/types.ts";
import type { WaitArmRow } from "../store/observations.ts";

/** Deadline and liveness are independent: expiry alone never establishes process death. */
export function watcherMetrics(arms: WaitArmRow[], now: number) {
  const open = arms.filter((a) => !a.ended_at);
  const parsed = open.map((arm) => ({
    arm,
    self: arm.process ? (JSON.parse(arm.process) as ProcessIdentity) : null,
    owners: arm.owner ? (JSON.parse(arm.owner) as ProcessIdentity[]) : [],
  }));
  const valid = (id: ProcessIdentity) => Number.isSafeInteger(id.pid) && id.pid > 0 && !!id.start;
  const ids = parsed.flatMap((a) => [...(a.self ? [a.self] : []), ...a.owners]).filter(valid);
  const checks = ids.length ? livenessAll(ids) : [];
  const evidence = new Map(ids.map((id, i) => [`${id.pid}:${id.start}`, checks[i]!]));
  const check = (id: ProcessIdentity): Liveness => evidence.get(`${id.pid}:${id.start}`) ?? "unknown";
  const counts = { live: 0, dead: 0, ownerLost: 0, unverified: 0, expired: 0, stale: 0 };
  const items = parsed.map(({ arm, self, owners }) => {
    const processLiveness = self ? check(self) : "unknown";
    const ownerChecks = owners.map(check);
    const ownerLiveness: Liveness = ownerChecks.includes("dead")
      ? "dead"
      : owners.length === 0 || ownerChecks.includes("unknown")
        ? "unknown"
        : "alive";
    const state =
      processLiveness === "dead"
        ? "dead"
        : processLiveness === "alive" && ownerLiveness === "dead"
          ? "ownerLost"
          : processLiveness === "alive" && ownerLiveness === "alive"
            ? "live"
            : "unverified";
    const deadline = arm.expires_at ? Date.parse(arm.expires_at) : Date.parse(arm.created_at) + MAX_WAIT_MS;
    const expired = deadline <= now;
    const stale = expired || state === "dead" || state === "ownerLost";
    counts[state]++;
    if (expired) counts.expired++;
    if (stale) counts.stale++;
    return {
      armId: arm.id,
      sessionId: arm.session_id,
      correlationId: arm.correlation,
      scope: arm.scope,
      createdAt: arm.created_at,
      expiresAt: arm.expires_at,
      effectiveExpiresAt: new Date(deadline).toISOString(),
      ageMs: Math.max(0, now - Date.parse(arm.created_at)),
      processLiveness,
      ownerLiveness,
      state,
      expired,
      stale,
    };
  });
  return { total: arms.length, ended: arms.length - open.length, unended: open.length, ...counts, items };
}
