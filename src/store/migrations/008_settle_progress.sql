-- A result supersedes its delegation's progress: closeDelegation now settles the parent's progress when a
-- result lands. Backfill finished delegations with the same rule, so stale progress neither counts as pending
-- mail nor keeps its worker from being pruned.
UPDATE receipts
SET acknowledged_at = d.closed_at,
    seen_source = CASE WHEN receipts.seen_at IS NULL THEN 'settlement' ELSE receipts.seen_source END,
    seen_at = coalesce(receipts.seen_at, d.closed_at),
    settled_reason = 'delegation_done'
FROM messages m
JOIN delegations d ON d.request_id = m.correlation_id
WHERE m.id = receipts.message_id
  AND receipts.acknowledged_at IS NULL
  AND m.type = 'progress'
  AND d.state = 'done';
