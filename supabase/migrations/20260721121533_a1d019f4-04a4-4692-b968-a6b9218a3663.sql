UPDATE public.landlord_payouts
SET status = 'completed',
    disbursed_at = COALESCE(disbursed_at, updated_at, now()),
    finops_disbursed_at = COALESCE(finops_disbursed_at, updated_at, now()),
    finops_notes = COALESCE(finops_notes,'') || E'\n[2026-07-21 reconcile] Marked completed retroactively — payout confirmed physically disbursed offline; no ledger retry to avoid double-posting.',
    updated_at = now()
WHERE id IN (
  'e1346efc-769e-45e3-a904-adbb479cfe7a','1c4dd0ac-4c98-428f-856d-039cb7e7e67b','f8a41083-f8c9-4ba9-ad0e-e49f8412f08f',
  '3828d8a9-b018-40da-b975-1f67e8612180','2b736a36-16fd-42b2-81b1-3cc941f3246c','0d77c107-fc4f-403d-84c3-0d4618c9ec48',
  'c0253069-4c26-45ab-8ca8-e34461b51e10','743d065e-f37d-4b97-a6d2-dca0a4a4a1fa','7895e899-d4de-46ca-8511-9955acb695a5',
  'f3a686c3-e2e7-4a24-818a-58d5cb9d65f4'
);

INSERT INTO public.audit_logs (action_type, table_name, record_id, metadata)
SELECT 'manual_reconcile_payout', 'landlord_payouts', id::text,
       jsonb_build_object(
         'agent','Katongole James',
         'amount',amount,
         'landlord_id',landlord_id,
         'reason','offline-paid: physically disbursed, status stamp only, no ledger movement to avoid double-post'
       )
FROM public.landlord_payouts
WHERE id IN (
  'e1346efc-769e-45e3-a904-adbb479cfe7a','1c4dd0ac-4c98-428f-856d-039cb7e7e67b','f8a41083-f8c9-4ba9-ad0e-e49f8412f08f',
  '3828d8a9-b018-40da-b975-1f67e8612180','2b736a36-16fd-42b2-81b1-3cc941f3246c','0d77c107-fc4f-403d-84c3-0d4618c9ec48',
  'c0253069-4c26-45ab-8ca8-e34461b51e10','743d065e-f37d-4b97-a6d2-dca0a4a4a1fa','7895e899-d4de-46ca-8511-9955acb695a5',
  'f3a686c3-e2e7-4a24-818a-58d5cb9d65f4'
);