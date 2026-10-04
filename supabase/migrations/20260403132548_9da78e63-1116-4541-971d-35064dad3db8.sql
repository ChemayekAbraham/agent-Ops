
-- Fix get_buffer_metrics: use cash_in/cash_out, filter platform scope, exclude opening_balance
CREATE OR REPLACE FUNCTION get_buffer_metrics()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'totalCashIn', COALESCE(SUM(CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE 0 END), 0),
    'totalCashOut', COALESCE(SUM(CASE WHEN gl.direction = 'cash_out' THEN gl.amount ELSE 0 END), 0)
  ) INTO result
  FROM general_ledger gl
  WHERE gl.ledger_scope = 'platform'
    AND gl.category != 'opening_balance';

  -- Add rent metrics
  SELECT json_build_object(
    'totalCashIn', (result->>'totalCashIn')::numeric,
    'totalCashOut', (result->>'totalCashOut')::numeric,
    'totalRentFacilitated', COALESCE(r.facilitated, 0),
    'totalRepaid', COALESCE(r.repaid, 0),
    'totalOutstanding', COALESCE(r.facilitated - r.repaid, 0),
    'defaultCount', COALESCE(r.default_count, 0),
    'totalFundedRequests', COALESCE(r.funded_count, 0)
  ) INTO result
  FROM (
    SELECT
      SUM(rent_amount) AS facilitated,
      SUM(amount_repaid) AS repaid,
      COUNT(*) AS funded_count,
      COUNT(*) FILTER (WHERE amount_repaid = 0 AND status NOT IN ('completed', 'funded')) AS default_count
    FROM rent_requests
    WHERE funded_at IS NOT NULL OR status IN ('funded', 'disbursed', 'completed')
  ) r;

  RETURN result;
END;
$$;

-- Fix get_buffer_trend_data: use cash_in/cash_out, filter platform scope, exclude opening_balance
CREATE OR REPLACE FUNCTION get_buffer_trend_data()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_agg(row_to_json(w)) INTO result
  FROM (
    SELECT
      to_char(date_trunc('week', transaction_date::date), 'Mon DD') AS week,
      SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END) AS "cashIn",
      SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END) AS "cashOut",
      SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END) AS "netFlow"
    FROM general_ledger
    WHERE transaction_date >= (now() - interval '12 weeks')
      AND ledger_scope = 'platform'
      AND category != 'opening_balance'
    GROUP BY date_trunc('week', transaction_date::date)
    ORDER BY date_trunc('week', transaction_date::date)
  ) w;

  RETURN COALESCE(result, '[]'::json);
END;
$$;
