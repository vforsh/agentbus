-- Milestone 3: provider observations, durable turn bindings and wait provenance.

-- generation: binding generation; bumped by every new contract binding, Codex run or unrelated input.
-- owner_generation: bumped by each Claude SessionStart (a new owning process).
-- bg_inventory: background task ids from the session's latest Stop; NULL when unknown.
ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN owner_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN bg_inventory TEXT;

CREATE TABLE turn_bindings (
  id               TEXT PRIMARY KEY,
  delegation_id    TEXT NOT NULL REFERENCES delegations (request_id),
  session_id       TEXT NOT NULL REFERENCES sessions (id),
  generation       INTEGER NOT NULL,
  owner_generation INTEGER,
  kind             TEXT NOT NULL CHECK (kind IN ('claude_prompt', 'codex_run')),
  origin           TEXT NOT NULL CHECK (origin IN ('contract', 'continuation', 'runner')),
  native_turn_id   TEXT,
  run_id           TEXT UNIQUE,
  predecessor_id   TEXT REFERENCES turn_bindings (id),
  state            TEXT NOT NULL CHECK (state IN ('prepared', 'active', 'finished', 'failed', 'interrupted')),
  tracking         TEXT NOT NULL DEFAULT 'ok' CHECK (tracking IN ('ok', 'lost')),
  tracking_reason  TEXT,
  bg_running       INTEGER,
  bg_task_ids      TEXT,
  bg_baseline      TEXT,
  permission_at    TEXT,
  started_at       TEXT,
  ended_at         TEXT,
  evidence_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (session_id, native_turn_id)
);

CREATE INDEX turn_bindings_delegation ON turn_bindings (delegation_id, generation, created_at);
CREATE INDEX turn_bindings_session ON turn_bindings (session_id, generation);

CREATE TABLE observations (
  id             TEXT PRIMARY KEY,
  occurrence_key TEXT UNIQUE,
  session_id     TEXT REFERENCES sessions (id),
  delegation_id  TEXT REFERENCES delegations (request_id),
  turn_ref       TEXT REFERENCES turn_bindings (id),
  generation     INTEGER,
  source         TEXT NOT NULL CHECK (source IN ('claude-hook', 'codex-runner', 'probe')),
  kind           TEXT NOT NULL,
  native_event   TEXT,
  native_turn_id TEXT,
  captured_at    TEXT NOT NULL,
  ingested_at    TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '{}',
  notice_id      TEXT REFERENCES messages (id),
  suppressed_by  TEXT
);

CREATE INDEX observations_session ON observations (session_id, captured_at);
CREATE INDEX observations_turn ON observations (turn_ref, captured_at);
CREATE INDEX observations_delegation ON observations (delegation_id, captured_at);

-- A wait records its origin when armed, so a later task notification can prove which bound turn armed it.
CREATE TABLE wait_arms (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions (id),
  delegation_id TEXT REFERENCES delegations (request_id),
  turn_ref      TEXT REFERENCES turn_bindings (id),
  correlation   TEXT,
  created_at    TEXT NOT NULL,
  ended_at      TEXT,
  end_reason    TEXT
);

CREATE INDEX wait_arms_session ON wait_arms (session_id, created_at);
