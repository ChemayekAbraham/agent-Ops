-- Idempotent generator: one receivable row per placed rent placement.
-- Receivable amount = daily rent (rent_requests.daily_repayment) x 30 days x 12 months.
CREATE OR REPLACE FUNCTION public.generate_landlord_receivables()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized: ops role required';
  END IF;

  INSERT INTO public.landlord_account_ledger
    (landlord_id, rent_request_id, tenant_id, entry_type,
     monthly_rent, daily_rent, months, days_per_month, amount, placement_status)
  SELECT
    rr.landlord_id,
    rr.id,
    rr.tenant_id,
    'receivable',
    COALESCE(rr.rent_amount, 0),
    COALESCE(rr.daily_repayment, 0),
    12,
    30,
    COALESCE(rr.daily_repayment, 0) * 30 * 12,
    rr.status
  FROM public.rent_requests rr
  WHERE rr.landlord_id IS NOT NULL
    AND rr.status IN ('funded', 'repaying', 'active', 'completed')
  ON CONFLICT (rent_request_id, entry_type) DO UPDATE SET
    landlord_id      = EXCLUDED.landlord_id,
    tenant_id        = EXCLUDED.tenant_id,
    monthly_rent     = EXCLUDED.monthly_rent,
    daily_rent       = EXCLUDED.daily_rent,
    amount           = EXCLUDED.amount,
    placement_status = EXCLUDED.placement_status,
    updated_at       = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_landlord_receivables() TO authenticated;