-- Doc 191. Desk BAITA (Immaculate Namulindwa, 1a88b1b8…) showed UGX 28.85M of
-- "own money" claims in needs_review since 2026-09-25. All 26 are bank_transfer
-- payouts. Merchant float funds bank payouts as well as MoMo, so these are gaps in
-- the float funding record (float credited late or outside the ledger), not
-- merchant own cash. The company owes the merchant nothing (CFO instruction
-- 2026-10-02).
--
-- The approve-withdrawal edge function kept filing them (doc 134 only patched
-- classify_merchant_payout_funding); that writer is fixed in the same commit.
--
-- Close the open ones like the 2026-09-25 batch: status rejected, no receivable.
-- Narrow on purpose: needs_review only, never attested or reviewed, not
-- reimbursed, bank_transfer payout. Small pending_reimbursement telecom rows are
-- left alone.

UPDATE public.merchant_out_of_pocket_advances o
SET status = 'rejected',
    reviewed_at = now(),
    review_note = 'FLOAT-FUNDED BANK PAYOUT 2026-10-02: prior status needs_review. '
      || 'Bank payout funded by merchant float, not merchant own cash; '
      || 'company owes nothing (CFO instruction 2026-10-02, doc 191).',
    updated_at = now()
FROM public.withdrawal_requests w
WHERE w.id = o.withdrawal_id
  AND w.payout_method = 'bank_transfer'
  AND o.status = 'needs_review'
  AND o.attested_at IS NULL
  AND o.reviewed_at IS NULL
  AND o.reimbursed_at IS NULL;
