
-- Backfill coo_approved_by metadata for records that went through COO approval
-- Based on audit_logs evidence of coo_roi_approval action
UPDATE pending_wallet_operations pwo
SET metadata = COALESCE(pwo.metadata, '{}'::jsonb) || jsonb_build_object(
  'coo_approved_by', al.user_id::text,
  'coo_approved_at', al.created_at::text
)
FROM audit_logs al
WHERE al.action_type = 'coo_roi_approval'
  AND al.table_name = 'pending_wallet_operations'
  AND al.record_id = pwo.id::text
  AND pwo.category = 'roi_payout'
  AND NOT (pwo.metadata ? 'coo_approved_by');
