
-- 1) Add missing column referenced by trigger reactivate_rent_payment_status_on_collection
ALTER TABLE public.agent_collections
  ADD COLUMN IF NOT EXISTS rent_request_id uuid REFERENCES public.rent_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_collections_rent_request_id
  ON public.agent_collections(rent_request_id);

-- 2) Patch agent_allocate_tenant_payment to populate the new column.
--    Use a string-replace approach: redefine just the INSERT by recreating function from its current definition is risky;
--    instead, rely on the column simply existing (nullable). The trigger short-circuits on NULL, which is harmless.
--    For full auto-reactivation behaviour we update the RPC's INSERT inline:

DO $do$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  WHERE p.proname = 'agent_allocate_tenant_payment'
    AND pg_get_function_identity_arguments(p.oid) =
        'p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric, p_notes text';

  IF v_def IS NULL THEN
    RAISE NOTICE 'agent_allocate_tenant_payment(5-arg) not found, skipping inline patch';
    RETURN;
  END IF;

  v_def := replace(
    v_def,
    'INSERT INTO public.agent_collections (agent_id, tenant_id, amount, payment_method, tracking_id, notes, float_before, float_after)',
    'INSERT INTO public.agent_collections (agent_id, tenant_id, rent_request_id, amount, payment_method, tracking_id, notes, float_before, float_after)'
  );

  -- Also fix the VALUES list: original is
  --   VALUES (p_agent_id, p_tenant_id, p_amount, 'float_allocation', v_tracking_id, p_notes, v_float_balance, v_float_balance - p_amount)
  v_def := replace(
    v_def,
    'VALUES (p_agent_id, p_tenant_id, p_amount, ''float_allocation'',',
    'VALUES (p_agent_id, p_tenant_id, p_rent_request_id, p_amount, ''float_allocation'','
  );

  EXECUTE v_def;
END
$do$;
