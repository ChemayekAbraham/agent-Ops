-- get_wallet_bucket_totals (2026-09-18): Financial Ops asked for the
-- "Landlord Float" bucket tile to show what we are actually going to pay
-- landlords TODAY, not the full agent_landlord_float balance sitting across
-- every agent (which is mostly older backlog, not same-day obligations --
-- confirmed live: the existing landlord_float_total was ~80.3M while only
-- one rent_request, UGX 4,000,000, was actually funded today and still
-- unpaid). landlord_float_total is left unchanged (other reads may still
-- want the raw held-float figure); a new landlord_float_due_today_total
-- field is added alongside it for the tile to switch to.
CREATE OR REPLACE FUNCTION public.get_wallet_bucket_totals()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_finance boolean;
  v_withdrawable numeric;
  v_float numeric;
  v_landlord numeric;
  v_landlord_due_today numeric;
  v_merchant numeric;
  v_computed_at timestamptz;
BEGIN
  v_is_finance := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo');

  IF NOT v_is_finance THEN
    RAISE EXCEPTION 'Wallet bucket totals are only visible to finance roles';
  END IF;

  SELECT total_withdrawable, total_float, computed_at
  INTO v_withdrawable, v_float, v_computed_at
  FROM public.wallet_totals_cache
  WHERE id = 1;

  SELECT COALESCE(SUM(GREATEST(bal.balance, 0)), 0)
  INTO v_landlord
  FROM public.agent_landlord_float bal;

  SELECT COALESCE(SUM(rr.rent_amount), 0)
  INTO v_landlord_due_today
  FROM public.rent_requests rr
  WHERE rr.funded_at IS NOT NULL
    AND (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date
    AND NOT EXISTS (
      SELECT 1 FROM public.landlord_payouts lp
      WHERE lp.rent_request_id = rr.id AND lp.status = 'completed'
    );

  SELECT COALESCE(SUM(GREATEST(w.float_balance, 0)), 0)
  INTO v_merchant
  FROM public.cashout_agents ca
  CROSS JOIN LATERAL public.wallet_strict_for_user(ca.agent_id) w
  WHERE ca.is_active = true;

  RETURN json_build_object(
    'withdrawable_total', COALESCE(v_withdrawable, 0),
    'float_total', COALESCE(v_float, 0),
    'landlord_float_total', v_landlord,
    'landlord_float_due_today_total', COALESCE(v_landlord_due_today, 0),
    'merchant_float_total', v_merchant,
    'computed_at', COALESCE(v_computed_at, now())
  );
END;
$function$;
