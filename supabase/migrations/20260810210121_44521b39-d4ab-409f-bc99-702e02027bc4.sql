CREATE OR REPLACE FUNCTION public._cf_partner_ops_portfolios()
RETURNS TABLE (
  id uuid, investor_id uuid, investment_amount numeric,
  roi_percentage numeric, anchor_date date, maturity_date date
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT ip.id,
         ip.investor_id,
         ip.investment_amount,
         COALESCE(ip.roi_percentage, 15) AS roi_percentage,
         CASE
           WHEN ip.next_roi_date IS NOT NULL THEN ip.next_roi_date::date
           ELSE (
             SELECT s.d
             FROM (
               SELECT (date_trunc('month', ip.created_at AT TIME ZONE 'Africa/Kampala')::date
                        + ((n + 1) || ' month')::interval)::date
                      + (LEAST(
                           COALESCE(ip.payout_day, EXTRACT(DAY FROM (ip.created_at AT TIME ZONE 'Africa/Kampala'))::int),
                           28
                         ) - 1) AS d
               FROM generate_series(0, 120) AS n
             ) s
             WHERE s.d >= (now() AT TIME ZONE 'Africa/Kampala')::date
             ORDER BY s.d
             LIMIT 1
           )
         END AS anchor_date,
         ip.maturity_date::date AS maturity_date
  FROM investor_portfolios ip
  WHERE ip.status IN ('active','pending_approval','pending')
    AND COALESCE(ip.investment_amount, 0) > 0;
$function$;

REVOKE ALL ON FUNCTION public._cf_partner_ops_portfolios() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._cf_partner_ops_portfolios() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_cashflow_forecast_series(p_start timestamp with time zone, p_end timestamp with time zone, p_bucket text DEFAULT 'day'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_unit text;
  v_buckets jsonb := '[]'::jsonb;
  v_cats jsonb := '[]'::jsonb;
  v_partners jsonb := '[]'::jsonb;
  v_tz text := 'Africa/Kampala';
BEGIN
  IF v_uid IS NULL OR NOT (
    has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
    OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view cashflow forecasts';
  END IF;

  v_unit := CASE lower(coalesce(p_bucket,'day'))
              WHEN 'week' THEN 'week'
              WHEN 'month' THEN 'month'
              ELSE 'day'
            END;

  WITH b AS (
    SELECT generate_series(
      date_trunc(v_unit, p_start AT TIME ZONE v_tz),
      date_trunc(v_unit, (p_end - interval '1 second') AT TIME ZONE v_tz),
      ('1 ' || v_unit)::interval
    ) AS bstart
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'key', to_char(bstart, 'YYYY-MM-DD'),
           'label', CASE v_unit
                      WHEN 'month' THEN to_char(bstart, 'Mon YYYY')
                      WHEN 'week' THEN 'Wk ' || to_char(bstart, 'DD Mon')
                      ELSE to_char(bstart, 'DD Mon')
                    END
         ) ORDER BY bstart), '[]'::jsonb)
    INTO v_buckets
  FROM b;

  -- 1. Forecast: projected partner Returns from Partner Ops portfolios
  WITH occ AS (
    SELECT pf.id, pf.investor_id,
           (pf.anchor_date + (n || ' month')::interval)::date AS due_date,
           ROUND(pf.investment_amount * pf.roi_percentage / 100.0) AS amount,
           pf.maturity_date
    FROM _cf_partner_ops_portfolios() pf CROSS JOIN generate_series(0, 36) AS n
    WHERE pf.anchor_date IS NOT NULL
  ), f AS (
    SELECT date_trunc(v_unit, due_date::timestamp) AS bstart, amount
    FROM occ
    WHERE due_date >= (p_start AT TIME ZONE v_tz)::date
      AND due_date <  (p_end AT TIME ZONE v_tz)::date
      AND (maturity_date IS NULL OR due_date <= maturity_date)
  )
  SELECT jsonb_build_array(jsonb_build_object(
           'key', 'roi_forecast',
           'label', 'Forecasted Returns (Partner Ops portfolios)',
           'kind', 'forecast',
           'total', COALESCE((SELECT SUM(amount) FROM f), 0),
           'count', COALESCE((SELECT COUNT(*) FROM f), 0),
           'points', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', to_char(bstart, 'YYYY-MM-DD'),
                      'amount', SUM(amount),
                      'count', COUNT(*)
                    ) ORDER BY bstart)
             FROM f GROUP BY bstart
           ), '[]'::jsonb)
         ))
    INTO v_cats;

  -- 1b. Per-partner projection inside the window
  WITH pf AS (
    SELECT * FROM _cf_partner_ops_portfolios()
  ), occ AS (
    SELECT pf.id, pf.investor_id,
           (pf.anchor_date + (n || ' month')::interval)::date AS due_date,
           ROUND(pf.investment_amount * pf.roi_percentage / 100.0) AS amount,
           pf.maturity_date
    FROM pf CROSS JOIN generate_series(0, 36) AS n
    WHERE pf.anchor_date IS NOT NULL
  ), w AS (
    SELECT * FROM occ
    WHERE due_date >= (p_start AT TIME ZONE v_tz)::date
      AND due_date <  (p_end AT TIME ZONE v_tz)::date
      AND (maturity_date IS NULL OR due_date <= maturity_date)
  ), byp AS (
    SELECT w.investor_id,
           SUM(w.amount) AS projected,
           COUNT(*) AS payouts,
           MIN(w.due_date) AS next_due,
           COUNT(DISTINCT w.id) AS portfolios,
           (SELECT SUM(p2.investment_amount) FROM pf p2 WHERE p2.investor_id = w.investor_id) AS committed
    FROM w GROUP BY w.investor_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'partner_id', byp.investor_id,
           'partner_name', COALESCE(pr.full_name, 'Partner'),
           'phone', pr.phone,
           'portfolios', byp.portfolios,
           'committed', COALESCE(byp.committed, 0),
           'payouts', byp.payouts,
           'next_due', byp.next_due,
           'projected', byp.projected
         ) ORDER BY byp.projected DESC), '[]'::jsonb)
    INTO v_partners
  FROM byp LEFT JOIN profiles pr ON pr.id = byp.investor_id;

  -- 2. Forecast: queued withdrawals still in the payout pipeline
  WITH w AS (
    SELECT date_trunc(v_unit, wr.created_at AT TIME ZONE v_tz) AS bstart, wr.amount
    FROM withdrawal_requests wr
    WHERE wr.status NOT IN ('completed','rejected','cancelled','failed')
      AND wr.created_at >= p_start AND wr.created_at < p_end
  )
  SELECT v_cats || jsonb_build_array(jsonb_build_object(
           'key', 'withdrawals_queued',
           'label', 'Queued withdrawals (pipeline)',
           'kind', 'forecast',
           'total', COALESCE((SELECT SUM(amount) FROM w), 0),
           'count', COALESCE((SELECT COUNT(*) FROM w), 0),
           'points', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', to_char(bstart, 'YYYY-MM-DD'),
                      'amount', SUM(amount),
                      'count', COUNT(*)
                    ) ORDER BY bstart)
             FROM w GROUP BY bstart
           ), '[]'::jsonb)
         ))
    INTO v_cats;

  -- 3. Actual outflow categories
  WITH src AS (
    SELECT gl.category,
           date_trunc(v_unit, gl.transaction_date AT TIME ZONE v_tz) AS bstart,
           gl.amount
    FROM general_ledger gl
    WHERE gl.direction = 'cash_out'
      AND gl.transaction_date >= p_start AND gl.transaction_date < p_end
      AND gl.classification <> 'admin_correction'
      AND gl.category IN (
        'roi_expense','wallet_withdrawal','rent_disbursement','agent_commission_earned',
        'agent_commission','payroll_expense','general_admin_expense','marketing_expense',
        'agent_float_deposit','agent_landlord_payout','rent_payment_for_tenant',
        'research_development_expense','agent_advance_credit','partner_funding'
      )
  ), agg AS (
    SELECT category, bstart, SUM(amount) AS amount, COUNT(*) AS cnt
    FROM src GROUP BY category, bstart
  )
  SELECT v_cats || COALESCE(jsonb_agg(c ORDER BY (c->>'total')::numeric DESC), '[]'::jsonb)
    INTO v_cats
  FROM (
    SELECT jsonb_build_object(
             'key', category,
             'label', initcap(replace(category, '_', ' ')),
             'kind', 'actual',
             'total', SUM(amount),
             'count', SUM(cnt),
             'points', jsonb_agg(jsonb_build_object(
                         'key', to_char(bstart, 'YYYY-MM-DD'),
                         'amount', amount,
                         'count', cnt
                       ) ORDER BY bstart)
           ) AS c
    FROM agg GROUP BY category
  ) x;

  RETURN jsonb_build_object(
    'bucket', v_unit,
    'start', p_start,
    'end', p_end,
    'buckets', v_buckets,
    'categories', v_cats,
    'partners', v_partners,
    'portfolio_count', (SELECT COUNT(*) FROM _cf_partner_ops_portfolios()),
    'committed_capital', COALESCE((SELECT SUM(investment_amount) FROM _cf_partner_ops_portfolios()), 0)
  );
END;
$function$;