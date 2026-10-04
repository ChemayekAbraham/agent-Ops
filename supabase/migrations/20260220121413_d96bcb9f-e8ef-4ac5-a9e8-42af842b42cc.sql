-- Fix function using a subquery to find the target rent request
CREATE OR REPLACE FUNCTION public.record_rent_request_repayment(
  p_tenant_id uuid,
  p_amount numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id uuid;
BEGIN
  -- Find the tenant's most recent approved rent request that still has balance
  SELECT id INTO v_request_id
  FROM public.rent_requests
  WHERE
    tenant_id = p_tenant_id
    AND status = 'approved'
    AND amount_repaid < total_repayment
  ORDER BY approved_at DESC
  LIMIT 1;

  IF v_request_id IS NOT NULL THEN
    UPDATE public.rent_requests
    SET
      amount_repaid = LEAST(total_repayment, amount_repaid + p_amount),
      updated_at = now()
    WHERE id = v_request_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_rent_request_repayment(uuid, numeric) TO service_role;