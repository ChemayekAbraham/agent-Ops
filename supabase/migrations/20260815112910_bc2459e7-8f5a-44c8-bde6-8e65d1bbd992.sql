CREATE OR REPLACE FUNCTION public.get_wallet_ledger_category_sums(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  direction text,
  category text,
  classification text,
  amount numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.direction::text, g.category::text, g.classification::text, sum(g.amount)::numeric
  FROM public.general_ledger g
  WHERE g.ledger_scope::text = 'wallet'
    AND g.transaction_date >= p_from
    AND g.transaction_date < p_to
  GROUP BY g.direction, g.category, g.classification;
$$;

REVOKE ALL ON FUNCTION public.get_wallet_ledger_category_sums(timestamptz, timestamptz) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_wallet_ledger_category_sums(timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_wallet_ledger_category_sums(timestamptz, timestamptz) TO authenticated, service_role;