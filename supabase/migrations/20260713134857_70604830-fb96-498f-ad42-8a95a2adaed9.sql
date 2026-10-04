-- deposit_request 472ef902 (TID151427954217, UGX 24,000) is a duplicate: the same
-- funds were already credited to the agent's float on 2026-07-11 via a routed-email
-- CFO direct credit (general_ledger 369acbd1). That credit is NOT linked to this
-- deposit request (source_table='cfo_direct_credit'), so the approval guardrail
-- correctly refuses to approve it, leaving it stuck as a phantom "pending receipt".
-- Approving would double-credit, so close it as already-credited instead.
UPDATE public.deposit_requests
SET status = 'rejected',
    rejected_at = now(),
    updated_at = now(),
    rejection_reason = 'Already credited: same funds posted to float on 2026-07-11 via routed-email CFO direct credit (ledger 369acbd1-d799-4435-b34f-890aab0e6d87, TID151427954217). Closed as duplicate to avoid double-credit and clear the phantom pending receipt.'
WHERE id = '472ef902-f6d3-43ec-9ae6-8ff5979956f2'
  AND status = 'pending';