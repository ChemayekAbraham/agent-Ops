CREATE OR REPLACE FUNCTION public.get_duplicate_roi_credits(
  p_window_seconds integer DEFAULT 120,
  p_lookback_days integer DEFAULT 30
)
RETURNS TABLE (
  portfolio_id uuid,
  portfolio_code text,
  beneficiary_name text,
  proxy_wallet_user_id uuid,
  cycle_month date,
  credit_count integer,
  total_amount numeric,
  excess_amount numeric,
  first_credit_at timestamptz,
  last_credit_at timestamptz,
  min_gap_seconds numeric,
  ledger_ids uuid[],
  ledger_references text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH roi AS (
    SELECT
      gl.id,
      gl.source_id AS portfolio_id,
      gl.user_id AS proxy_wallet_user_id,
      date_trunc('month', gl.created_at)::date AS cycle_month,
      gl.created_at,
      gl.amount,
      gl.reference_id,
      lag(gl.created_at) OVER (
        PARTITION BY gl.source_id, date_trunc('month', gl.created_at)
        ORDER BY gl.created_at
      ) AS prev_at
    FROM public.general_ledger gl
    WHERE gl.category = 'roi_wallet_credit'
      AND gl.source_table = 'investor_portfolios'
      AND gl.source_id IS NOT NULL
      AND gl.created_at >= now() - make_interval(days => GREATEST(p_lookback_days, 1))
  ),
  gaps AS (
    SELECT *,
      CASE WHEN prev_at IS NOT NULL
           THEN extract(epoch FROM (created_at - prev_at))
           ELSE NULL END AS gap_seconds
    FROM roi
  ),
  flagged AS (
    SELECT portfolio_id, cycle_month
    FROM gaps
    GROUP BY portfolio_id, cycle_month
    HAVING count(*) > 1
       AND min(gap_seconds) FILTER (WHERE gap_seconds IS NOT NULL) <= GREATEST(p_window_seconds, 1)
  )
  SELECT
    g.portfolio_id,
    ip.portfolio_code,
    COALESCE(pr.full_name, ip.account_name, ip.bank_account_name) AS beneficiary_name,
    (array_agg(g.proxy_wallet_user_id ORDER BY g.created_at))[1] AS proxy_wallet_user_id,
    g.cycle_month,
    count(*)::int AS credit_count,
    sum(g.amount) AS total_amount,
    sum(g.amount) - max(g.amount) AS excess_amount,
    min(g.created_at) AS first_credit_at,
    max(g.created_at) AS last_credit_at,
    min(g.gap_seconds) FILTER (WHERE g.gap_seconds IS NOT NULL) AS min_gap_seconds,
    array_agg(g.id ORDER BY g.created_at) AS ledger_ids,
    array_agg(g.reference_id ORDER BY g.created_at) AS ledger_references
  FROM gaps g
  JOIN flagged f ON f.portfolio_id = g.portfolio_id AND f.cycle_month = g.cycle_month
  LEFT JOIN public.investor_portfolios ip ON ip.id = g.portfolio_id
  LEFT JOIN public.profiles pr ON pr.id = ip.investor_id
  GROUP BY g.portfolio_id, ip.portfolio_code, beneficiary_name, g.cycle_month
  ORDER BY min(g.gap_seconds) FILTER (WHERE g.gap_seconds IS NOT NULL) ASC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_duplicate_roi_credits(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_duplicate_roi_credits(integer, integer) TO service_role;