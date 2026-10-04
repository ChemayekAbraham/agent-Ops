CREATE OR REPLACE FUNCTION public.search_wallets_by_balance(
  p_min_balance numeric DEFAULT 0,
  p_max_balance numeric DEFAULT 999999999999,
  p_limit integer DEFAULT 50
)
RETURNS TABLE(
  user_id uuid,
  full_name text,
  phone text,
  balance numeric,
  withdrawable_balance numeric,
  float_balance numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    s.user_id,
    p.full_name,
    p.phone,
    COALESCE(s.withdrawable, 0)::numeric AS balance,
    COALESCE(s.withdrawable, 0)::numeric AS withdrawable_balance,
    COALESCE(s.float_balance, 0)::numeric AS float_balance
  FROM public.v_user_wallet_strict s
  JOIN public.profiles p ON p.id = s.user_id
  WHERE COALESCE(s.withdrawable, 0) >= p_min_balance
    AND COALESCE(s.withdrawable, 0) <= p_max_balance
    AND COALESCE(s.withdrawable, 0) > 0
  ORDER BY s.withdrawable DESC NULLS LAST
  LIMIT p_limit;
$function$;

GRANT EXECUTE ON FUNCTION public.search_wallets_by_balance(numeric, numeric, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.search_wallets_by_balance(numeric, numeric, integer) IS
  'Wallet Deduction search: filters and returns only ledger-backed withdrawable funds as the deductible balance; float is informational only.';