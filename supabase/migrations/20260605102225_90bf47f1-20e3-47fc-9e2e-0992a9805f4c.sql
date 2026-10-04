CREATE OR REPLACE FUNCTION public.get_wallet_totals()
RETURNS json
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
  WITH wallet_count AS (
    SELECT COUNT(*) AS total_wallets
    FROM public.wallets
    WHERE user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid
  ), strict_totals AS (
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(total_visible, 0) > 0) AS active_wallets,
      COALESCE(SUM(COALESCE(total_visible, 0)), 0) AS total_balance,
      COALESCE(SUM(COALESCE(float_balance, 0)), 0) AS total_float,
      COALESCE(SUM(COALESCE(withdrawable, 0)), 0) AS total_withdrawable
    FROM public.v_user_wallet_strict
    WHERE user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid
  )
  SELECT json_build_object(
    'total_wallets', wallet_count.total_wallets,
    'active_wallets', strict_totals.active_wallets,
    'total_balance', strict_totals.total_balance,
    'total_float', strict_totals.total_float,
    'total_withdrawable', strict_totals.total_withdrawable
  )
  FROM wallet_count, strict_totals;
$function$;

GRANT EXECUTE ON FUNCTION public.get_wallet_totals() TO authenticated, service_role;