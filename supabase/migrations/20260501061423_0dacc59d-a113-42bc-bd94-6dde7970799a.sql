CREATE OR REPLACE FUNCTION public.get_wallet_totals_strict()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH joined AS (
    SELECT
      w.user_id,
      COALESCE(w.balance, 0)                                       AS cached_balance,
      COALESCE(s.withdrawable, 0) + COALESCE(s.float_balance, 0)   AS strict_balance
    FROM public.wallets w
    LEFT JOIN public.v_user_wallet_strict s ON s.user_id = w.user_id
    WHERE w.user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid
  )
  SELECT json_build_object(
    'strict_total',    COALESCE(SUM(strict_balance), 0),
    'drifted_wallets', COUNT(*) FILTER (WHERE cached_balance - strict_balance > 100),
    'total_drift',     COALESCE(SUM(GREATEST(cached_balance - strict_balance, 0)), 0)
  )
  FROM joined;
$function$;

GRANT EXECUTE ON FUNCTION public.get_wallet_totals_strict() TO authenticated, service_role;

COMMENT ON FUNCTION public.get_wallet_totals_strict() IS
  'Operator-facing strict ledger companion to get_wallet_totals(). Returns strict_total + cache drift summary for Fin Ops Wallet Overview card.';