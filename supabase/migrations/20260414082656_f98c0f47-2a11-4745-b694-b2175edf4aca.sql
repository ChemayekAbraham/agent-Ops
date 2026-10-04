
CREATE OR REPLACE FUNCTION public.backfill_agent_commission(
  p_rent_request_id uuid,
  p_repayment_amount numeric,
  p_tenant_id uuid,
  p_event_reference_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);
  PERFORM set_config('app.bypass_category_check', 'true', true);
  RETURN public.credit_agent_rent_commission(p_rent_request_id, p_repayment_amount, p_tenant_id, p_event_reference_id);
END;
$$;
