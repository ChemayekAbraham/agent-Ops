CREATE OR REPLACE FUNCTION public.get_wallet_totals()
RETURNS JSON
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'total_wallets', COUNT(*),
    'active_wallets', COUNT(*) FILTER (WHERE balance > 0),
    'total_balance', COALESCE(SUM(balance), 0)
  )
  FROM wallets;
$$;