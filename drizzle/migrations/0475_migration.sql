CREATE OR REPLACE FUNCTION public.cfo_agent_lending_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r jsonb; t date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF NOT (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'manager')
          OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'coo')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  WITH l AS (
    SELECT *, GREATEST(0, round(principal_ugx*(1+COALESCE(interest_rate_pct,0)/100)) - COALESCE(amount_repaid_ugx,0)) AS owed
    FROM lending_agent_loans WHERE status IN ('active','partially_repaid')
  ), pay AS (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date d, sum(amount_ugx) amt, count(*) n
    FROM lending_audit_log WHERE action_type='repayment_recorded'
      AND created_at >= now() - interval '30 days' GROUP BY 1
  )
  SELECT jsonb_build_object(
    'outstanding', COALESCE((SELECT sum(owed) FROM l),0),
    'loans', (SELECT count(*) FROM l),
    'borrowers', (SELECT count(DISTINCT COALESCE(borrower_user_id::text, borrower_phone)) FROM l),
    'agents', (SELECT count(DISTINCT lender_agent_id) FROM l),
    'overdue', COALESCE((SELECT sum(owed) FROM l WHERE expected_repayment_date < t),0),
    'overdue_loans', (SELECT count(*) FROM l WHERE expected_repayment_date < t),
    'repaid_30d', COALESCE((SELECT sum(amt) FROM pay),0),
    'payments_30d', COALESCE((SELECT sum(n) FROM pay),0),
    'daily', COALESCE((SELECT jsonb_agg(jsonb_build_object('date', g::date, 'amount', COALESCE(p.amt,0)) ORDER BY g)
       FROM generate_series(t - 29, t, interval '1 day') g LEFT JOIN pay p ON p.d = g::date), '[]'::jsonb)
  ) INTO r;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.cfo_agent_lending_summary() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cfo_agent_lending_summary() TO authenticated;