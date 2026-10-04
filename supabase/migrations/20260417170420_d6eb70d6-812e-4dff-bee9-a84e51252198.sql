
-- Server-side aggregate totals across ALL agents (no row transfer to client)
CREATE OR REPLACE FUNCTION public.get_agent_ops_totals()
RETURNS TABLE (
  total_count bigint,
  total_withdrawable numeric,
  total_float numeric,
  total_advance numeric,
  total_held numeric,
  with_withdrawable bigint,
  with_float bigint,
  with_advance bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COUNT(DISTINCT ur.user_id)::bigint AS total_count,
    COALESCE(SUM(w.withdrawable_balance), 0)::numeric AS total_withdrawable,
    COALESCE(SUM(w.float_balance), 0)::numeric AS total_float,
    COALESCE(SUM(w.advance_balance), 0)::numeric AS total_advance,
    COALESCE(SUM(w.withdrawable_balance + w.float_balance + w.advance_balance), 0)::numeric AS total_held,
    COUNT(*) FILTER (WHERE w.withdrawable_balance > 0)::bigint AS with_withdrawable,
    COUNT(*) FILTER (WHERE w.float_balance > 0)::bigint AS with_float,
    COUNT(*) FILTER (WHERE w.advance_balance > 0)::bigint AS with_advance
  FROM user_roles ur
  LEFT JOIN wallets w ON w.user_id = ur.user_id
  WHERE ur.role = 'agent';
$$;

-- Paginated, sortable, searchable agent rows joined with profile + wallet
CREATE OR REPLACE FUNCTION public.get_agent_ops_balances(
  _search text DEFAULT NULL,
  _sort text DEFAULT 'total',
  _limit int DEFAULT 50,
  _offset int DEFAULT 0
)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  phone text,
  territory text,
  withdrawable numeric,
  float_balance numeric,
  advance numeric,
  total numeric,
  total_matched bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q text;
BEGIN
  q := NULLIF(TRIM(_search), '');
  RETURN QUERY
  WITH base AS (
    SELECT
      ur.user_id,
      p.full_name,
      p.phone,
      p.territory,
      COALESCE(w.withdrawable_balance, 0)::numeric AS withdrawable,
      COALESCE(w.float_balance, 0)::numeric AS float_balance,
      COALESCE(w.advance_balance, 0)::numeric AS advance,
      COALESCE(w.withdrawable_balance + w.float_balance + w.advance_balance, 0)::numeric AS total
    FROM user_roles ur
    LEFT JOIN profiles p ON p.id = ur.user_id
    LEFT JOIN wallets w ON w.user_id = ur.user_id
    WHERE ur.role = 'agent'
      AND (
        q IS NULL
        OR p.full_name ILIKE '%' || q || '%'
        OR p.phone ILIKE '%' || q || '%'
        OR p.territory ILIKE '%' || q || '%'
      )
  ),
  counted AS (
    SELECT COUNT(*)::bigint AS c FROM base
  )
  SELECT
    b.user_id,
    b.full_name,
    b.phone,
    b.territory,
    b.withdrawable,
    b.float_balance,
    b.advance,
    b.total,
    (SELECT c FROM counted) AS total_matched
  FROM base b
  ORDER BY
    CASE WHEN _sort = 'total' THEN b.total END DESC NULLS LAST,
    CASE WHEN _sort = 'withdrawable' THEN b.withdrawable END DESC NULLS LAST,
    CASE WHEN _sort = 'float' THEN b.float_balance END DESC NULLS LAST,
    CASE WHEN _sort = 'advance' THEN b.advance END DESC NULLS LAST,
    CASE WHEN _sort = 'name' THEN b.full_name END ASC NULLS LAST,
    b.user_id
  LIMIT GREATEST(1, LEAST(_limit, 200))
  OFFSET GREATEST(0, _offset);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_ops_totals() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_balances(text, text, int, int) TO authenticated;
