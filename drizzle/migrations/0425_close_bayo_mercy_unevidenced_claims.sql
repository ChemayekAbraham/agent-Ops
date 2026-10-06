-- Doc 192. Three Bayo Mercy "own money" claims (UGX 38,141,536) sat in
-- pending_reimbursement and made up ~99% of the UGX 38.4M payable total in the
-- merchant settlement-debts view. They were filed by the Phase 6 classifier with
-- empty evidence, no attestation, no Finance review and no payout TID; the only
-- support was Mercy's own float position reading negative (-42.44M), which is our
-- ledger, not proof of cash. Her float is netted by hand and funded outside the
-- ledger (Mercy daily settlement 2026-10-01). The company owes no one; CFO
-- instruction 2026-10-02: close as rejected.
--
-- Closed by exact id, and only while still untouched (never attested, reviewed or
-- reimbursed), so a later human decision on any of them is never overwritten.

UPDATE public.merchant_out_of_pocket_advances
SET status = 'rejected',
    reviewed_at = now(),
    review_note = 'NO PROOF OF OWN MONEY 2026-10-02: prior status pending_reimbursement. '
      || 'Filed by classifier with empty evidence, never attested or reviewed; float is netted '
      || 'and funded outside the ledger. Company owes nothing (CFO instruction 2026-10-02, doc 192).',
    updated_at = now()
WHERE id IN (
    'e3e3b55d-7c18-48b1-bf83-77f158ccf73b',  -- 28,430,000  paid 2026-09-30 14:33 UTC
    'e9c68947-826f-4e14-8573-fc05874b10ab',  --  1,098,000  paid 2026-09-30 14:39 UTC
    '21925578-db55-4a1f-8ebe-70e089377a58'   --  8,613,536  paid 2026-10-01 09:15 UTC
  )
  AND status = 'pending_reimbursement'
  AND attested_at IS NULL
  AND reviewed_at IS NULL
  AND reimbursed_at IS NULL;
