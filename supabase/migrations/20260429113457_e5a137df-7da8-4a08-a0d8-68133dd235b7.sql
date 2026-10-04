DROP FUNCTION IF EXISTS public.search_wallets_by_balance(numeric, numeric, integer);

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
    w.user_id,
    p.full_name,
    p.phone,
    w.balance,
    COALESCE(w.withdrawable_balance, 0)::numeric AS withdrawable_balance,
    COALESCE(w.float_balance, 0)::numeric AS float_balance
  FROM wallets w
  JOIN profiles p ON p.id = w.user_id
  WHERE w.balance >= p_min_balance
    AND w.balance <= p_max_balance
  ORDER BY w.withdrawable_balance DESC NULLS LAST, w.balance DESC
  LIMIT p_limit;
$function$;

GRANT EXECUTE ON FUNCTION public.search_wallets_by_balance(numeric, numeric, integer) TO authenticated, service_role;