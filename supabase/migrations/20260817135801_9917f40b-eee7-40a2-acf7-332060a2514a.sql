-- Heal the two orphaned split-ROI cash portions (Bruno Kato UGX 4,000,000;
-- Katongole James UGX 2,480,000). They were submitted with status 'pending',
-- which sits outside both approval queues (COO reads 'pending_coo_approval',
-- CFO reads 'coo_approved'), so they were never credited or paid out.
-- No new rows are created; the original ids, amounts, references and metadata
-- are preserved.
UPDATE public.pending_wallet_operations
SET status = 'pending_coo_approval',
    updated_at = now(),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'status_repair', jsonb_build_object(
        'from', 'pending',
        'to', 'pending_coo_approval',
        'reason', 'Split-ROI cash portion was orphaned outside the COO/CFO approval queues',
        'repaired_at', now()
      )
    )
WHERE id IN (
  'f9aa9980-8716-40e6-8e92-771073224d61',
  '4b05f1a4-e069-4fb4-acf4-1796bf04f9e8'
)
AND status = 'pending'
AND category = 'roi_payout'
AND operation_type = 'roi_split_cash';