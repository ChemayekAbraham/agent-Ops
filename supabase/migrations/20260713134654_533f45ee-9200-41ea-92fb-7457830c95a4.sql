-- Reconcile phantom pending receipt: deposit_request 472ef902 was already credited
-- to the agent's float on 2026-07-11 via the email-routing path (ledger 369acbd1),
-- but the deposit request was never flipped from pending -> approved, so the
-- "Pending receipt" card kept showing it. Mark it approved to clear the phantom.
UPDATE public.deposit_requests
SET status = 'approved',
    approved_at = '2026-07-11 06:44:27.040144+00',
    updated_at = now(),
    notes = COALESCE(notes || ' | ', '') ||
            'Reconciled: funds already credited to float via email-routing path (ledger 369acbd1-d799-4435-b34f-890aab0e6d87, TID151427954217). Marked approved to clear phantom pending receipt.'
WHERE id = '472ef902-f6d3-43ec-9ae6-8ff5979956f2'
  AND status = 'pending';