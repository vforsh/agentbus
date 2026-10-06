-- Return-path evidence: what a running wait covers and who owns it, so a parent's readiness is derived from a
-- live watcher instead of a reported flag. NULL columns mark arms recorded before this migration: their
-- coverage and owner are unknown, so they never prove a currently armed return path.
--
-- scope:      'all' (unfiltered: every delegation of the session, including later ones), 'correlation' (one
--             request), 'settled' (a --settled snapshot of the delegations open when armed) or 'filtered'
--             (--from/--type: cannot be relied on to deliver everything).
-- process:    {"pid", "start"} of the wait process itself.
-- owner:      [{"pid", "start"}, ...] its nearest ancestors when armed; one of them ending means the process
--             tree that the wait's exit would re-invoke is gone (crash, kill, respawned or resumed owner).
-- expires_at: when the wait's own timeout ends it.
ALTER TABLE wait_arms ADD COLUMN scope TEXT CHECK (scope IN ('all', 'correlation', 'settled', 'filtered'));
ALTER TABLE wait_arms ADD COLUMN process TEXT;
ALTER TABLE wait_arms ADD COLUMN owner TEXT;
ALTER TABLE wait_arms ADD COLUMN expires_at TEXT;

CREATE INDEX wait_arms_open ON wait_arms (session_id, created_at) WHERE ended_at IS NULL;
