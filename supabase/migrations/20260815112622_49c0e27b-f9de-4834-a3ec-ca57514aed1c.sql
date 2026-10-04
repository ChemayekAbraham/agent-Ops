CREATE OR REPLACE FUNCTION public.get_financial_statement_ledger_sums(
  p_start timestamptz DEFAULT NULL,
  p_end timestamptz DEFAULT NULL
)
RETURNS TABLE (
  period text,
  ledger_scope text,
  direction text,
  category text,
  desc_bucket text,
  amount numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      'current'::text AS period,
      g.ledger_scope::text AS ledger_scope,
      g.direction::text AS direction,
      g.category::text AS category,
      CASE
        WHEN g.category::text <> 'system_balance_correction' THEN NULL
        WHEN lower(coalesce(g.description,'')) LIKE '%marketing expenses%' THEN 'Marketing Expenses'
        WHEN lower(coalesce(g.description,'')) LIKE '%research & development%' THEN 'Research & Development'
        WHEN lower(coalesce(g.description,'')) LIKE '%→ salaries%' THEN '→ Salaries'
        WHEN lower(coalesce(g.description,'')) LIKE '%→ transport%' THEN '→ Transport'
        WHEN lower(coalesce(g.description,'')) LIKE '%→ food%' THEN '→ Food'
        WHEN lower(coalesce(g.description,'')) LIKE '%→ office rent%' THEN '→ Office Rent'
        WHEN lower(coalesce(g.description,'')) LIKE '%→ internet%' THEN '→ Internet'
        WHEN lower(coalesce(g.description,'')) LIKE '%→ airtime%' THEN '→ Airtime'
        WHEN lower(coalesce(g.description,'')) LIKE '%→ stationery%' THEN '→ Stationery'
        WHEN lower(coalesce(g.description,'')) LIKE '%→ property & equipment%' THEN '→ Property & Equipment'
        WHEN lower(coalesce(g.description,'')) LIKE '%→ taxes%' THEN '→ Taxes'
        WHEN lower(coalesce(g.description,'')) LIKE '%→ interests%' THEN '→ Interests'
        ELSE NULL
      END AS desc_bucket,
      g.amount
    FROM public.general_ledger g
    WHERE g.classification IN ('production','legacy_real')
      AND g.ledger_scope::text IN ('platform','wallet','bridge')
      AND (p_start IS NULL OR g.transaction_date >= p_start)
      AND (p_end IS NULL OR g.transaction_date <= p_end)

    UNION ALL

    SELECT
      'prior'::text,
      g.ledger_scope::text,
      g.direction::text,
      g.category::text,
      NULL::text,
      g.amount
    FROM public.general_ledger g
    WHERE p_start IS NOT NULL
      AND g.classification IN ('production','legacy_real')
      AND g.ledger_scope::text = 'platform'
      AND g.transaction_date < p_start
  )
  SELECT period, ledger_scope, direction, category, desc_bucket, sum(amount)::numeric AS amount
  FROM base
  GROUP BY period, ledger_scope, direction, category, desc_bucket;
$$;

REVOKE ALL ON FUNCTION public.get_financial_statement_ledger_sums(timestamptz, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.get_financial_statement_ledger_sums(timestamptz, timestamptz) TO authenticated, service_role;