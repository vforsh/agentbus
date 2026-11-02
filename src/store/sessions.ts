import { conflict, notFound, usageError } from "../errors.ts";
import { type AnyProvider, MAX_LABELS, type Provider } from "../protocol/types.ts";
import { isUuid, newId, nowIso } from "../util/misc.ts";
import type { Db } from "./db.ts";
import { SYSTEM_OBSERVER_ID } from "./db.ts";

export interface SessionRow {
  id: string;
  provider: AnyProvider;
  external_id: string | null;
  name: string | null;
  cwd: string | null;
  cwd_real: string | null;
  labels: string;
  adapter_binding: string;
  return_binding: string | null;
  created_at: string;
  updated_at: string;
  bound_at: string | null;
  generation: number;
  owner_generation: number;
  bg_inventory: string | null;
}

export interface Session {
  id: string;
  provider: AnyProvider;
  externalId: string | null;
  address: string | null;
  pending: boolean;
  name: string | null;
  cwd: string | null;
  cwdReal: string | null;
  labels: Record<string, string>;
  adapterBinding: Record<string, unknown>;
  returnBinding: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  boundAt: string | null;
  generation: number;
  ownerGeneration: number;
}

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    address: row.external_id ? `${row.provider}:${row.external_id}` : null,
    pending: row.external_id === null,
    name: row.name,
    cwd: row.cwd,
    cwdReal: row.cwd_real,
    labels: JSON.parse(row.labels),
    adapterBinding: JSON.parse(row.adapter_binding),
    returnBinding: row.return_binding ? JSON.parse(row.return_binding) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    boundAt: row.bound_at,
    generation: row.generation,
    ownerGeneration: row.owner_generation,
  };
}

const GENERIC_ID_RE = /^[A-Za-z0-9._:@/+-]{1,128}$/;

/** Native identifiers: Codex thread IDs and Claude session IDs are full UUIDs; generic IDs are bounded tokens. */
export function validateExternalId(provider: Provider, id: string): void {
  if (provider === "generic") {
    if (!GENERIC_ID_RE.test(id)) {
      throw usageError("Generic external IDs must be 1-128 characters of [A-Za-z0-9._:@/+-]", {
        externalId: id,
      });
    }
    return;
  }
  if (!isUuid(id)) {
    throw usageError(
      `${provider} external IDs must be full session UUIDs (short handles such as claude --bg IDs are not identities)`,
      { externalId: id },
    );
  }
}

export function getSession(db: Db, id: string): SessionRow | null {
  return db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
}

export function findByExternal(db: Db, provider: string, externalId: string): SessionRow | null {
  return db
    .query<SessionRow, [string, string]>("SELECT * FROM sessions WHERE provider = ? AND external_id = ?")
    .get(provider, externalId);
}

/** Resolves `<uuid>` (internal ID) or `<provider>:<native-id>`; names are never routing addresses. */
export function resolveAddress(db: Db, address: string): SessionRow | null {
  if (isUuid(address)) return getSession(db, address);
  const idx = address.indexOf(":");
  if (idx <= 0) {
    throw usageError(`Invalid address "${address}": use an internal session UUID or <provider>:<native-id>`, {
      address,
    });
  }
  const provider = address.slice(0, idx);
  const ext = address.slice(idx + 1);
  if (!["codex", "claude", "generic", "system"].includes(provider)) {
    throw usageError(`Unknown provider in address "${address}"`, { address });
  }
  return findByExternal(db, provider, ext);
}

export function requireAddress(db: Db, address: string, role = "recipient"): SessionRow {
  const row = resolveAddress(db, address);
  if (!row) throw notFound("session_not_found", `No registered session for ${role} ${address}`, { address });
  return row;
}

export interface RegisterInput {
  provider: Provider;
  externalId: string | null;
  name: string | null;
  cwd: string | null;
  cwdReal: string | null;
  labels: Record<string, string>;
}

/** Idempotent on (provider, external_id); pending sessions always get a fresh internal ID. */
export function registerSession(db: Db, input: RegisterInput): { row: SessionRow; created: boolean } {
  if (input.externalId) {
    const existing = findByExternal(db, input.provider, input.externalId);
    if (existing) return { row: existing, created: false };
  }
  const id = newId();
  const now = nowIso();
  db.query(
    `INSERT INTO sessions (id, provider, external_id, name, cwd, cwd_real, labels, created_at, updated_at, bound_at)
     VALUES ($id, $provider, $ext, $name, $cwd, $cwdReal, $labels, $now, $now, $boundAt)`,
  ).run({
    id,
    provider: input.provider,
    ext: input.externalId,
    name: input.name,
    cwd: input.cwd,
    cwdReal: input.cwdReal,
    labels: JSON.stringify(input.labels),
    now,
    boundAt: input.externalId ? now : null,
  });
  return { row: getSession(db, id)!, created: true };
}

/** Binds a pending session's native ID; an identical existing binding confirms, a different one conflicts. */
export function bindSession(
  db: Db,
  session: SessionRow,
  externalId: string,
  adapterPatch: Record<string, unknown>,
): { row: SessionRow; alreadyBound: boolean } {
  if (session.provider === "system") throw usageError("The system observer cannot be bound");
  validateExternalId(session.provider, externalId);
  if (session.external_id && session.external_id !== externalId) {
    throw conflict("binding_conflict", `Session ${session.id} is already bound to ${session.external_id}`, {
      sessionId: session.id,
      boundTo: session.external_id,
      requested: externalId,
    });
  }
  const other = findByExternal(db, session.provider, externalId);
  if (other && other.id !== session.id) {
    throw conflict(
      "binding_conflict",
      `${session.provider}:${externalId} already belongs to session ${other.id}`,
      {
        sessionId: session.id,
        ownedBy: other.id,
      },
    );
  }
  const alreadyBound = session.external_id === externalId;
  const binding = { ...JSON.parse(session.adapter_binding), ...adapterPatch };
  const now = nowIso();
  db.query(
    `UPDATE sessions SET external_id = ?, adapter_binding = ?, updated_at = ?, bound_at = coalesce(bound_at, ?)
     WHERE id = ?`,
  ).run(externalId, JSON.stringify(binding), now, now, session.id);
  return { row: getSession(db, session.id)!, alreadyBound };
}

/** Names a session that has none; explicit names are never overwritten. */
export function nameIfUnnamed(db: Db, sessionId: string, name: string): void {
  db.query("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ? AND name IS NULL").run(
    name,
    nowIso(),
    sessionId,
  );
}

export function patchAdapterBinding(db: Db, sessionId: string, patch: Record<string, unknown>): void {
  const row = getSession(db, sessionId);
  if (!row) return;
  const binding = { ...JSON.parse(row.adapter_binding), ...patch };
  db.query("UPDATE sessions SET adapter_binding = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(binding),
    nowIso(),
    sessionId,
  );
}

export function listSessions(db: Db): SessionRow[] {
  return db
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE id <> ? ORDER BY created_at")
    .all(SYSTEM_OBSERVER_ID);
}

export function parseLabels(
  pairs: string[] | undefined,
  base: Record<string, string> = {},
): Record<string, string> {
  const labels = { ...base };
  for (const pair of pairs ?? []) {
    const idx = pair.indexOf("=");
    if (idx <= 0) throw usageError(`Labels must be key=value pairs, got "${pair}"`);
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) throw usageError(`Invalid label key "${key}"`);
    if (value.length > 200) throw usageError(`Label ${key} is longer than 200 characters`);
    labels[key] = value;
  }
  if (Object.keys(labels).length > MAX_LABELS) throw usageError(`At most ${MAX_LABELS} labels are allowed`);
  return labels;
}

export const displayName = (row: Pick<SessionRow, "name" | "id">): string => row.name ?? row.id.slice(0, 8);
