-- Existing seen timestamps have no reliable provenance. Leave them unknown rather than guessing
-- from equality with ack: a real delivery and ack can occur in the same millisecond.
ALTER TABLE receipts ADD COLUMN seen_source TEXT
  CHECK (seen_source IN ('wait', 'doorbell', 'read', 'ack', 'settlement'));

CREATE INDEX delegations_opened ON delegations (opened_at);
