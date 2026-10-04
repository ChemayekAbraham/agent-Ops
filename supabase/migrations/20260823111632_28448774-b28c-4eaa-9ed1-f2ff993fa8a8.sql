CREATE OR REPLACE FUNCTION public.get_wallet_bucket_totals()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_is_finance boolean;
  v_withdrawable numeric;
  v_float numeric;
  v_landlord numeric;
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

  SELECT COALESCE(SUM(GREATEST(v.float_balance, 0)), 0)
  INTO v_merchant
  FROM public.v_user_wallet_strict v
  JOIN public.cashout_agents ca ON ca.agent_id = v.user_id
  WHERE ca.is_active = true;

  RETURN json_build_object(
    'withdrawable_total', COALESCE(v_withdrawable, 0),
    'float_total', COALESCE(v_float, 0),
    'landlord_float_total', v_landlord,
    'merchant_float_total', v_merchant,
    'computed_at', COALESCE(v_computed_at, now())
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_wallet_bucket_totals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_wallet_bucket_totals() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_bucket_totals() TO service_role;