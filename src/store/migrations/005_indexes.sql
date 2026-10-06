-- Indexes for lookups by worker and recipient, and for foreign-key children of rows `prune` deletes: without
-- them every deleted message or session scans whole tables while the write lock is held.
CREATE INDEX delegations_worker ON delegations (worker_id);
CREATE INDEX delegations_result ON delegations (result_id);
CREATE INDEX messages_to ON messages (to_id);
CREATE INDEX observations_notice ON observations (notice_id);
CREATE INDEX turn_bindings_predecessor ON turn_bindings (predecessor_id);
CREATE INDEX wait_arms_delegation ON wait_arms (delegation_id);
CREATE INDEX wait_arms_turn ON wait_arms (turn_ref);
