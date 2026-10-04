CREATE OR REPLACE FUNCTION public.search_wallets_by_balance(
  p_min_balance numeric DEFAULT 0,
  p_max_balance numeric DEFAULT 999999999999,
  p_limit int DEFAULT 50
)
RETURNS TABLE(user_id uuid, full_name text, phone text, balance numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.user_id, p.full_name, p.phone, w.balance
  FROM wallets w
  JOIN profiles p ON p.id = w.user_id
  WHERE w.balance >= p_min_balance
    AND w.balance <= p_max_balance
  ORDER BY w.balance DESC
  LIMIT p_limit;
$$;