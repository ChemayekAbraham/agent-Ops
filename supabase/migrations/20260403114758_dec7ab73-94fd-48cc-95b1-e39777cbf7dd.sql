
-- Temporarily allow updates to append-only ledger for backfill
ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;

-- Reclassify revenue entries from 'wallet' to 'platform' scope
UPDATE general_ledger 
SET ledger_scope = 'platform'
WHERE ledger_scope = 'wallet'
  AND category IN (
    'tenant_access_fee', 
    'tenant_request_fee', 
    'platform_service_income', 
    'landlord_platform_fee',
    'management_fee', 
    'rent_repayment'
  );

-- Re-enable ledger mutation protection
ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
