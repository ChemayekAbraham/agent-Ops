
-- Server-side aggregation for Buffer Account metrics
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
    'totalCashIn', COALESCE(SUM(CASE WHEN gl.direction = 'credit' THEN gl.amount ELSE 0 END), 0),
    'totalCashOut', COALESCE(SUM(CASE WHEN gl.direction = 'debit' THEN gl.amount ELSE 0 END), 0)
  ) INTO result
  FROM general_ledger gl;

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

-- Server-side aggregation for Buffer Trend (weekly cash flow, last 12 weeks)
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
      SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END) AS "cashIn",
      SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END) AS "cashOut",
      SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS "netFlow"
    FROM general_ledger
    WHERE transaction_date >= (now() - interval '12 weeks')
    GROUP BY date_trunc('week', transaction_date::date)
    ORDER BY date_trunc('week', transaction_date::date)
  ) w;

  RETURN COALESCE(result, '[]'::json);
END;
$$;

-- Server-side aggregation for Supporter Pool Balance
CREATE OR REPLACE FUNCTION get_supporter_pool_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total_in numeric;
  total_out numeric;
  total_withdrawn numeric;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO total_in
  FROM general_ledger WHERE category = 'supporter_rent_fund';

  SELECT COALESCE(SUM(amount), 0) INTO total_out
  FROM general_ledger WHERE category = 'pool_rent_deployment';

  SELECT COALESCE(SUM(amount), 0) INTO total_withdrawn
  FROM general_ledger WHERE category = 'supporter_capital_return';

  RETURN json_build_object(
    'poolBalance', total_in - total_out,
    'totalDeployed', total_out,
    'monthlyObligation', ROUND((total_in - total_withdrawn) * 0.15),
    'deployableAmount', GREATEST(0, (total_in - total_out) - ROUND((total_in - total_withdrawn) * 0.15))
  );
END;
$$;

-- Server-side count for rent requests by status (for RentRequestsManager pagination)
CREATE OR REPLACE FUNCTION get_rent_requests_summary()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN (
    SELECT json_build_object(
      'total', COUNT(*),
      'pending', COUNT(*) FILTER (WHERE status = 'pending'),
      'approved', COUNT(*) FILTER (WHERE status = 'approved'),
      'funded', COUNT(*) FILTER (WHERE status = 'funded'),
      'disbursed', COUNT(*) FILTER (WHERE status = 'disbursed'),
      'completed', COUNT(*) FILTER (WHERE status = 'completed'),
      'rejected', COUNT(*) FILTER (WHERE status = 'rejected'),
      'totalReceivable', COALESCE(SUM(total_repayment - amount_repaid) FILTER (WHERE status = 'approved' OR status = 'funded' OR status = 'disbursed'), 0)
    )
    FROM rent_requests
  );
END;
$$;
