-- Remove chronologically-impossible proxy payout settlements created by the
-- one-time FIFO backfill migration (20260617115158).
--
-- Root cause: that backfill matched delivered withdrawals to a partner's
-- unsettled ROI approvals using `ORDER BY pwo.created_at DESC` (newest first).
-- For partners whose OLD withdrawals had not yet written a settlement row, the
-- backfill applied those OLD (already-delivered, already-accounted) withdrawals
-- to the partner's NEWEST approvals — including fresh, current-date CFO
-- approvals that the old withdrawal could not possibly have paid.
--
-- Effect: the amount-aware proxy partner list subtracted these phantom
-- settlements, so current approvals displayed less than the CFO actually
-- approved (e.g. THE GREAT MARRIEDS: 5,000,000 approved today shown as
-- 2,000,000 because a 2026-04-17 withdrawal was wrongly applied to it).
--
-- Fix: delete every backfill settlement whose underlying withdrawal was
-- delivered BEFORE the approval it was matched to. A withdrawal cannot pay an
-- approval that did not exist yet, so these rows are unambiguously wrong. The
-- old withdrawals were already closed against their own contemporaneous
-- approvals (real or synthetic strict-withdrawable closures), so removing these
-- rows restores the correct owed amount on the newer approvals without
-- reopening any genuinely-paid older approval.
DELETE FROM public.proxy_payout_settlements s
USING public.withdrawal_requests w,
      public.pending_wallet_operations o
WHERE s.withdrawal_id = w.id
  AND s.approval_id = o.id
  AND s.notes ILIKE 'Backfill: retroactive FIFO%'
  AND w.created_at < o.created_at;