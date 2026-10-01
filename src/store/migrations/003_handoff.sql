-- Milestone 4: scheduled wakeups observed at Stop, for the Desktop handoff guard. NULL means unknown.
ALTER TABLE turn_bindings ADD COLUMN crons INTEGER;
