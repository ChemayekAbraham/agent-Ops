-- Partner Ops Returns forecast vs actual, plus receivables / top-ups / promissory / compounding
CREATE OR REPLACE FUNCTION public.get_partner_ops_returns_forecast(
  p_start timestamptz,
  p_end timestamptz,
  p_bucket text DEFAULT 'month'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_unit text;
  v_tz text := 'Africa/Kampala';
  v_rows jsonb := '[]'::jsonb;
  v_today date;
BEGIN
  IF v_uid IS NULL OR NOT (
    has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
    OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view Partner Ops forecasts';
  END IF;

  v_unit := CASE lower(coalesce(p_bucket,'month'))
              WHEN 'day' THEN 'day'
              WHEN 'week' THEN 'week'
              ELSE 'month'
            END;
  v_today := (now() AT TIME ZONE v_tz)::date;

  WITH b AS (
    SELECT generate_series(
      date_trunc(v_unit, p_start AT TIME ZONE v_tz),
      date_trunc(v_unit, (p_end - interval '1 second') AT TIME ZONE v_tz),
      ('1 ' || v_unit)::interval
    ) AS bstart
  ),
  pf AS (
    SELECT ip.id, ip.investor_id, ip.investment_amount,
           COALESCE(ip.roi_percentage, 15) AS roi_percentage,
           ip.maturity_date::date AS maturity_date,
           (ip.created_at AT TIME ZONE v_tz)::date AS started_on,
           ip.status,
           COALESCE(ip.auto_reinvest,false) AS auto_reinvest,
           CASE
             WHEN ip.next_roi_date IS NOT NULL THEN ip.next_roi_date::date
             ELSE (date_trunc('month', ip.created_at AT TIME ZONE v_tz)::date
                    + interval '1 month')::date
                  + (LEAST(COALESCE(ip.payout_day,
                       EXTRACT(DAY FROM (ip.created_at AT TIME ZONE v_tz))::int), 28) - 1)
           END AS anchor_date
    FROM investor_portfolios ip
    WHERE ip.status IN ('active','pending_approval','pending')
      AND COALESCE(ip.investment_amount,0) > 0
  ),
  occ AS (
    -- project each portfolio's monthly Returns cycle backwards and forwards
    -- so past buckets carry the figure that WAS forecast for them
    SELECT (pf.anchor_date + (n || ' month')::interval)::date AS due_date,
           ROUND(pf.investment_amount * pf.roi_percentage / 100.0) AS amount
    FROM pf CROSS JOIN generate_series(-48, 48) AS n
    WHERE pf.anchor_date IS NOT NULL
  ),
  fc AS (
    SELECT date_trunc(v_unit, o.due_date::timestamp) AS bstart,
           SUM(o.amount) AS amount, COUNT(*) AS cnt
    FROM occ o
    JOIN pf ON true
    WHERE FALSE GROUP BY 1
  ),
  forecast AS (
    SELECT date_trunc(v_unit, due_date::timestamp) AS bstart,
           SUM(amount) AS amount, COUNT(*) AS cnt
    FROM (
      SELECT (pf.anchor_date + (n || ' month')::interval)::date AS due_date,
             ROUND(pf.investment_amount * pf.roi_percentage / 100.0) AS amount
      FROM pf CROSS JOIN generate_series(-48, 48) AS n
      WHERE pf.anchor_date IS NOT NULL
    ) s
    JOIN pf p2 ON true
    WHERE FALSE
    GROUP BY 1
  ),
  fcast AS (
    SELECT date_trunc(v_unit, x.due_date::timestamp) AS bstart,
           SUM(x.amount) AS amount, COUNT(*) AS cnt
    FROM (
      SELECT (pf.anchor_date + (n || ' month')::interval)::date AS due_date,
             ROUND(pf.investment_amount * pf.roi_percentage / 100.0) AS amount,
             pf.started_on, pf.maturity_date
      FROM pf CROSS JOIN generate_series(-48, 48) AS n
      WHERE pf.anchor_date IS NOT NULL
    ) x
    WHERE x.due_date >= x.started_on
      AND (x.maturity_date IS NULL OR x.due_date <= x.maturity_date)
    GROUP BY 1
  ),
  paid AS (
    SELECT date_trunc(v_unit, gl.transaction_date AT TIME ZONE v_tz) AS bstart,
           SUM(gl.amount) AS amount, COUNT(*) AS cnt
    FROM general_ledger gl
    WHERE gl.category = 'roi_expense'
      AND gl.direction = 'cash_out'
      AND gl.ledger_scope = 'platform'
      AND gl.classification <> 'admin_correction'
    GROUP BY 1
  ),
  compounding AS (
    SELECT date_trunc(v_unit, gl.transaction_date AT TIME ZONE v_tz) AS bstart,
           SUM(gl.amount) AS amount
    FROM general_ledger gl
    WHERE gl.category = 'roi_reinvestment'
      AND gl.direction = 'cash_in'
      AND gl.ledger_scope = 'platform'
      AND gl.classification <> 'admin_correction'
    GROUP BY 1
  ),
  topups AS (
    SELECT date_trunc(v_unit, gl.transaction_date AT TIME ZONE v_tz) AS bstart,
           SUM(gl.amount) AS amount
    FROM general_ledger gl
    WHERE gl.category = 'pending_portfolio_topup'
      AND gl.direction = 'cash_in'
      AND gl.ledger_scope = 'platform'
      AND gl.classification <> 'admin_correction'
    GROUP BY 1
  ),
  partner_recv AS (
    -- committed partner capital not yet verified as received
    SELECT date_trunc(v_unit, pf.started_on::timestamp) AS bstart,
           SUM(pf.investment_amount) AS amount
    FROM pf
    WHERE pf.status IN ('pending','pending_approval')
    GROUP BY 1
  ),
  promissory AS (
    SELECT date_trunc(v_unit,
             COALESCE(pn.fulfilment_due_on, pn.next_deduction_date,
                      pn.recorded_on, (pn.created_at AT TIME ZONE v_tz)::date)::timestamp
           ) AS bstart,
           SUM(pn.amount) AS amount
    FROM promissory_notes pn
    WHERE pn.status = 'pending'
      AND COALESCE(pn.amount,0) > 0
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'key', to_char(b.bstart, 'YYYY-MM-DD'),
           'label', CASE v_unit
                      WHEN 'month' THEN to_char(b.bstart, 'Mon YYYY')
                      WHEN 'week' THEN 'Wk ' || to_char(b.bstart, 'DD Mon')
                      ELSE to_char(b.bstart, 'DD Mon')
                    END,
           'is_past', (b.bstart::date <= v_today),
           'forecast_returns', COALESCE(f.amount, 0),
           'forecast_count', COALESCE(f.cnt, 0),
           'actual_returns_paid', COALESCE(pd.amount, 0),
           'actual_count', COALESCE(pd.cnt, 0),
           'variance', COALESCE(pd.amount, 0) - COALESCE(f.amount, 0),
           'partner_receivable', COALESCE(pr.amount, 0),
           'topups', COALESCE(tu.amount, 0),
           'promissory_receivable', COALESCE(pm.amount, 0),
           'compounding', COALESCE(cp.amount, 0),
           'net', COALESCE(pr.amount,0) + COALESCE(tu.amount,0)
                  + COALESCE(pm.amount,0) + COALESCE(cp.amount,0)
                  - CASE WHEN b.bstart::date <= v_today
                         THEN COALESCE(pd.amount,0) ELSE COALESCE(f.amount,0) END
         ) ORDER BY b.bstart), '[]'::jsonb)
    INTO v_rows
  FROM b
  LEFT JOIN fcast f ON f.bstart = b.bstart
  LEFT JOIN paid pd ON pd.bstart = b.bstart
  LEFT JOIN compounding cp ON cp.bstart = b.bstart
  LEFT JOIN topups tu ON tu.bstart = b.bstart
  LEFT JOIN partner_recv pr ON pr.bstart = b.bstart
  LEFT JOIN promissory pm ON pm.bstart = b.bstart;

  RETURN jsonb_build_object(
    'bucket', v_unit,
    'start', p_start,
    'end', p_end,
    'today', v_today,
    'rows', v_rows,
    'portfolio_count', (SELECT COUNT(*) FROM investor_portfolios ip
                        WHERE ip.status IN ('active','pending_approval','pending')
                          AND COALESCE(ip.investment_amount,0) > 0),
    'committed_capital', COALESCE((SELECT SUM(investment_amount) FROM investor_portfolios ip
                        WHERE ip.status IN ('active','pending_approval','pending')), 0),
    'promissory_outstanding', COALESCE((SELECT SUM(amount) FROM promissory_notes WHERE status = 'pending'), 0),
    'partner_receivable_outstanding', COALESCE((SELECT SUM(investment_amount) FROM investor_portfolios
                        WHERE status IN ('pending','pending_approval')), 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_partner_ops_returns_forecast(timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_partner_ops_returns_forecast(timestamptz, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_ops_returns_forecast(timestamptz, timestamptz, text) TO service_role;
