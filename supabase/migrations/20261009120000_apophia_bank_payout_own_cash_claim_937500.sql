-- Doc 213. Tugabirwe Apophia (f7a64907-4c93-4a50-b7ac-cb192a78d71c) paid
-- withdrawal 6a370ad0 (UGX 936,000 bank transfer to DFCU "Namulindwa Immaculate",
-- completed 2026-10-08 17:44 UTC) with ZERO float: her float was exhausted at
-- 17:32 UTC and the next top-up only arrived 2026-10-09 07:25 UTC.
--
-- The classifier (20260925140500) deliberately files completed bank_transfer
-- payouts as `needs_review` with no receivable (treasury-funded policy, doc 134),
-- so this one payout is the only one of her five zero-float payouts that night
-- with no claim: her owed total reads 987,500 instead of 1,925,000.
--
-- Josh instructed (2026-10-09) that this payout was fronted from her own money and
-- must be recorded, which the classifier note allows ("Finance may raise one by
-- hand with evidence"). Raised as pending_reimbursement for 936,000 principal +
-- 1,500 telecom = 937,500.
--
-- Notes on safety:
--  * The note deliberately does NOT start with 'Phase 6 classification:', which is
--    the only prefix the classifier's cleanup DELETE touches, so the nightly
--    reconciler will not remove these rows.
--  * pending_reimbursement is not a payable by itself: the settlement dialog still
--    requires `is_evidenced`, recomputed from the float position at the payout time.
--  * ON CONFLICT DO NOTHING keeps this idempotent and never overwrites a human
--    decision made on the same (withdrawal_id, kind) later.

INSERT INTO public.merchant_out_of_pocket_advances
  (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
   shortfall_amount, status, note, evidence)
SELECT w.processed_by, w.id, 'payout', 936000, 1500, 0, 936000, 'pending_reimbursement',
       'RAISED BY HAND 2026-10-09 (doc 213): bank-transfer payout of UGX 936,000 completed with zero float '
       || '(float exhausted 2026-10-08 17:32 UTC, next top-up 2026-10-09 07:25 UTC). Recorded as the merchant''s '
       || 'own money on Josh''s instruction; the treasury-funded bank-payout rule (doc 134) was not applied.',
       jsonb_build_object('recorded_by', 'doc-213-manual', 'float_before', 0, 'float_used', 0,
                          'awaiting', 'Finance evidence of own-money source')
FROM public.withdrawal_requests w
WHERE w.id = '6a370ad0-8ca8-40b3-844a-79d79f777a1e'
  AND w.processed_by = 'f7a64907-4c93-4a50-b7ac-cb192a78d71c'
  AND w.status = 'completed'
ON CONFLICT (withdrawal_id, kind) DO NOTHING;

INSERT INTO public.merchant_out_of_pocket_advances
  (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
   shortfall_amount, status, note, evidence)
SELECT w.processed_by, w.id, 'telecom', 936000, 1500, 0, 1500, 'pending_reimbursement',
       'RAISED BY HAND 2026-10-09 (doc 213): UGX 1,500 telecom sending charge on the same payout, paid from the '
       || 'merchant''s own line with no float to cover it.',
       jsonb_build_object('recorded_by', 'doc-213-manual', 'float_before', 0, 'float_used', 0)
FROM public.withdrawal_requests w
WHERE w.id = '6a370ad0-8ca8-40b3-844a-79d79f777a1e'
  AND w.processed_by = 'f7a64907-4c93-4a50-b7ac-cb192a78d71c'
  AND w.status = 'completed'
ON CONFLICT (withdrawal_id, kind) DO NOTHING;

-- Keep the funding row consistent with the claims (the reconciler re-derives
-- receivable_recorded from the advances, so this matches what it will write).
UPDATE public.merchant_payout_funding
SET receivable_recorded = (
      SELECT COALESCE(SUM(shortfall_amount), 0)
      FROM public.merchant_out_of_pocket_advances
      WHERE withdrawal_id = '6a370ad0-8ca8-40b3-844a-79d79f777a1e'),
    updated_at = now()
WHERE withdrawal_id = '6a370ad0-8ca8-40b3-844a-79d79f777a1e';
