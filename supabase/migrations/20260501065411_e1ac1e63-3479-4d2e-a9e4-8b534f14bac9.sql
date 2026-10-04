-- Align wallet_historical_drift_review.status check constraint with the
-- lifecycle values the reseed_anchored_withdrawable RPC actually writes.
-- The RPC inserts 'pending_decision' and then updates to 'reseed_posted',
-- but the existing CHECK only permitted (pending_review, approved_release,
-- approved_writedown, escalated), causing every reseed to fail.
ALTER TABLE public.wallet_historical_drift_review
  DROP CONSTRAINT IF EXISTS wallet_historical_drift_review_status_check;

ALTER TABLE public.wallet_historical_drift_review
  ADD CONSTRAINT wallet_historical_drift_review_status_check
  CHECK (status = ANY (ARRAY[
    'pending_review'::text,
    'pending_decision'::text,
    'reseed_posted'::text,
    'approved_release'::text,
    'approved_writedown'::text,
    'escalated'::text
  ]));