-- Milestone 2: durable mailbox. Sessions, immutable messages, per-recipient receipts and delegations.

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'generic', 'system')),
  external_id     TEXT,
  name            TEXT,
  cwd             TEXT,
  cwd_real        TEXT,
  labels          TEXT NOT NULL DEFAULT '{}',
  adapter_binding TEXT NOT NULL DEFAULT '{}',
  return_binding  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  bound_at        TEXT,
  UNIQUE (provider, external_id)
);

CREATE INDEX sessions_name ON sessions (name);

CREATE TABLE messages (
  sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  schema_version  INTEGER NOT NULL,
  from_id         TEXT NOT NULL REFERENCES sessions (id),
  to_id           TEXT NOT NULL REFERENCES sessions (id),
  type            TEXT NOT NULL CHECK (type IN ('message', 'request', 'progress', 'question', 'result', 'notice')),
  summary         TEXT,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  correlation_id  TEXT NOT NULL,
  in_reply_to     TEXT REFERENCES messages (id),
  idempotency_key TEXT,
  intent_hash     TEXT,
  outcome         TEXT CHECK (outcome IN ('success', 'blocked', 'failed', 'unknown')),
  notice          TEXT,
  turn_ref        TEXT,
  CHECK ((type = 'result') = (outcome IS NOT NULL)),
  CHECK ((type = 'notice') = (notice IS NOT NULL)),
  UNIQUE (from_id, idempotency_key)
);

CREATE INDEX messages_correlation ON messages (correlation_id, sequence);
CREATE INDEX messages_in_reply_to ON messages (in_reply_to);
CREATE INDEX messages_turn_ref ON messages (turn_ref) WHERE turn_ref IS NOT NULL;

CREATE TABLE receipts (
  message_id      TEXT PRIMARY KEY REFERENCES messages (id),
  recipient_id    TEXT NOT NULL REFERENCES sessions (id),
  sequence        INTEGER NOT NULL,
  seen_at         TEXT,
  acknowledged_at TEXT
);

CREATE INDEX receipts_inbox ON receipts (recipient_id, sequence);
CREATE INDEX receipts_pending ON receipts (recipient_id, sequence) WHERE acknowledged_at IS NULL;

CREATE TABLE delegations (
  request_id         TEXT PRIMARY KEY REFERENCES messages (id),
  parent_id          TEXT NOT NULL REFERENCES sessions (id),
  worker_id          TEXT NOT NULL REFERENCES sessions (id),
  state              TEXT NOT NULL CHECK (state IN ('open', 'done', 'closed')),
  outcome            TEXT CHECK (outcome IN ('success', 'blocked', 'failed', 'unknown')),
  result_id          TEXT REFERENCES messages (id),
  contract_version   INTEGER,
  contract           TEXT,
  return_path        TEXT NOT NULL,
  return_path_status TEXT NOT NULL,
  return_path_reason TEXT,
  opened_at          TEXT NOT NULL,
  closed_at          TEXT,
  CHECK (parent_id <> worker_id)
);

CREATE UNIQUE INDEX delegations_one_open_per_worker ON delegations (worker_id) WHERE state = 'open';
CREATE INDEX delegations_parent ON delegations (parent_id, state, opened_at);

INSERT INTO sessions (id, provider, external_id, name, created_at, updated_at, bound_at)
VALUES ('00000000-0000-4000-8000-000000000000', 'system', 'observer', 'observer',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
