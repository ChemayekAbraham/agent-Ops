-- 1) Attach the orphaned collections (null rent_request_id) to the plan they belong to
UPDATE public.agent_collections
SET rent_request_id = 'cb360149-525e-4e1a-b60d-260a6477dd03'
WHERE tenant_id = '6aa7fa2a-2e70-4142-8c00-14fb4f584d53'
  AND rent_request_id IS NULL
  AND created_at < '2026-06-01';

-- 2) Repair the repaid cache: 130,000 collected vs 77,541 expected -> fully repaid
UPDATE public.rent_requests
SET amount_repaid = total_repayment,
    updated_at = now()
WHERE id = 'cb360149-525e-4e1a-b60d-260a6477dd03'
  AND COALESCE(amount_repaid, 0) < total_repayment;

-- 3) Audit trail
INSERT INTO public.audit_logs (action_type, action, table_name, record_id, metadata)
VALUES (
  'rent_request_repaid_cache_corrected',
  'Corrected repaid cache on completed rent plan',
  'rent_requests',
  'cb360149-525e-4e1a-b60d-260a6477dd03',
  jsonb_build_object(
    'reason', 'Kabanda Emanuel (+256703401855) plan showed UGX 77,541 outstanding on a completed plan. 13 agent collections totalling UGX 130,000 (>= expected 77,541) were recorded in agent_collections/repayments but amount_repaid stayed 0 because the first four collections had a null rent_request_id, so the sync path never applied them. Setting amount_repaid = total_repayment (77,541) and backfilling the missing plan links.',
    'tenant_id', '6aa7fa2a-2e70-4142-8c00-14fb4f584d53',
    'amount_repaid', 77541,
    'total_repayment', 77541,
    'collections_total', 130000,
    'collections_count', 13
  )
);