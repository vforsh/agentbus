-- Return-path status is derived from current evidence each time it is shown (returnpath.ts). The column only held
-- the proposal made when the delegation opened and was never updated, so it read as stale state; drop it.
ALTER TABLE delegations DROP COLUMN return_path_status;
