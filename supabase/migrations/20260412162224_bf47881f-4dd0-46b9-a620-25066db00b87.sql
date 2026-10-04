
CREATE OR REPLACE FUNCTION get_platform_cash_breakdown()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN (
    SELECT json_agg(row_to_json(t))
    FROM (
      SELECT
        category,
        direction,
        COUNT(*) as entry_count,
        SUM(amount) as total_amount
      FROM general_ledger
      WHERE ledger_scope = 'platform'
        AND classification IN ('production', 'legacy_real')
        AND category != 'opening_balance'
      GROUP BY category, direction
      ORDER BY SUM(amount) DESC
    ) t
  );
END;
$$;
