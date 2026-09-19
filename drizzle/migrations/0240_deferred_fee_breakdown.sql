CREATE OR REPLACE FUNCTION public.get_deferred_fee_breakdown(p_as_at timestamptz)
RETURNS TABLE(group_label text, legs bigint, amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    CASE l.category
      WHEN 'treasury_fee_recognised' THEN 'Fees recognised on new rent plans'
      WHEN 'treasury_fee_drawdown'   THEN 'Fees earned as tenants repay'
      WHEN 'treasury_allocated'      THEN 'Treasury allocations'
      ELSE initcap(replace(l.category, '_', ' '))
    END AS group_label,
    count(*) AS legs,
    round(sum(l.cr - l.dr)) AS amount
  FROM public.sofp_ledger_legs(p_as_at) l
  WHERE l.account_code = 'L7'
  GROUP BY 1
  ORDER BY abs(sum(l.cr - l.dr)) DESC;
$$;

REVOKE ALL ON FUNCTION public.get_deferred_fee_breakdown(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_deferred_fee_breakdown(timestamptz) TO authenticated;