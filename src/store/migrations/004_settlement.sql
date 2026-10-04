-- Mail settled by a delegation's terminal transition: Agentbus acknowledged the receipt on the recipient's
-- behalf because nothing is left to handle. NULL means the recipient acknowledged it (or it is pending).
ALTER TABLE receipts ADD COLUMN settled_reason TEXT
  CHECK (settled_reason IN ('delegation_done', 'delegation_closed'));

-- Backfill with the same rule closeDelegation applies: a result settles the worker's side; a parent's close
-- settles the whole correlation.
UPDATE receipts
SET acknowledged_at = d.closed_at,
    seen_at = coalesce(receipts.seen_at, d.closed_at),
    settled_reason = 'delegation_' || d.state
FROM messages m
JOIN delegations d ON d.request_id = m.correlation_id
WHERE m.id = receipts.message_id
  AND receipts.acknowledged_at IS NULL
  AND (d.state = 'closed' OR (d.state = 'done' AND receipts.recipient_id = d.worker_id));

-- Follow-ups sent before they joined the delegation's correlation: parent-to-worker mail of a finished
-- delegation, sent while it was open, settles with it.
UPDATE receipts
SET acknowledged_at = d.closed_at,
    seen_at = coalesce(receipts.seen_at, d.closed_at),
    settled_reason = 'delegation_' || d.state
FROM messages m
JOIN delegations d ON d.parent_id = m.from_id AND d.worker_id = m.to_id
WHERE m.id = receipts.message_id
  AND receipts.acknowledged_at IS NULL
  AND d.state <> 'open'
  AND m.correlation_id = m.id
  AND m.type = 'message'
  AND m.created_at BETWEEN d.opened_at AND d.closed_at;
