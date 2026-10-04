-- Predict future partner top-ups from recent top-up behaviour.
-- Past buckets keep showing real posted top-ups; future buckets get a
-- damped-trend projection from the last completed buckets. Read-only.

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
  v_cur_bucket date;
  v_base numeric := 0;
  v_trend numeric := 0;
  v_basis int := 0;
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
  v_cur_bucket := date_trunc(v_unit, v_today::timestamp)::date;

  WITH hist AS (
    SELECT date_trunc(v_unit, gl.transaction_date AT TIME ZONE v_tz)::date AS bstart,
           SUM(gl.amount) AS amount
    FROM general_ledger gl
    WHERE gl.category = 'pending_portfolio_topup'
      AND gl.direction = 'cash_in'
      AND gl.ledger_scope = 'platform'
      AND gl.classification <> 'admin_correction'
      AND (gl.transaction_date AT TIME ZONE v_tz)::date < v_cur_bucket
    GROUP BY 1
  ),
  recent AS (
    SELECT bstart, amount
    FROM hist
    ORDER BY bstart DESC
    LIMIT 6
  )
  SELECT COALESCE(AVG(amount), 0), COUNT(*)
    INTO v_base, v_basis
  FROM recent;

  IF v_basis >= 4 THEN
    WITH hist AS (
      SELECT date_trunc(v_unit, gl.transaction_date AT TIME ZONE v_tz)::date AS bstart,
             SUM(gl.amount) AS amount
      FROM general_ledger gl
      WHERE gl.category = 'pending_portfolio_topup'
        AND gl.direction = 'cash_in'
        AND gl.ledger_scope = 'platform'
        AND gl.classification <> 'admin_correction'
        AND (gl.transaction_date AT TIME ZONE v_tz)::date < v_cur_bucket
      GROUP BY 1
    ),
    recent AS (
      SELECT amount, ROW_NUMBER() OVER (ORDER BY bstart DESC) AS rn
      FROM hist
      ORDER BY bstart DESC
      LIMIT 6
    )
    SELECT 0.5 * (
             COALESCE(AVG(amount) FILTER (WHERE rn <= 3), 0)
             - COALESCE(AVG(amount) FILTER (WHERE rn > 3), 0)
           )
      INTO v_trend
    FROM recent;
  END IF;

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
  ),
  agg AS (
    SELECT b.bstart,
           COALESCE(f.amount, 0) AS forecast_returns,
           COALESCE(f.cnt, 0) AS forecast_count,
           COALESCE(pd.amount, 0) AS actual_paid,
           COALESCE(pd.cnt, 0) AS actual_count,
           COALESCE(pr.amount, 0) AS partner_receivable,
           COALESCE(tu.amount, 0) AS topups,
           COALESCE(pm.amount, 0) AS promissory_receivable,
           COALESCE(cp.amount, 0) AS compounding,
           GREATEST(
             0,
             (EXTRACT(EPOCH FROM (b.bstart - v_cur_bucket::timestamp))
               / EXTRACT(EPOCH FROM ('1 ' || v_unit)::interval))::int
           ) AS steps_ahead
    FROM b
    LEFT JOIN fcast f ON f.bstart = b.bstart
    LEFT JOIN paid pd ON pd.bstart = b.bstart
    LEFT JOIN compounding cp ON cp.bstart = b.bstart
    LEFT JOIN topups tu ON tu.bstart = b.bstart
    LEFT JOIN partner_recv pr ON pr.bstart = b.bstart
    LEFT JOIN promissory pm ON pm.bstart = b.bstart
  ),
  shaped AS (
    SELECT a.*,
           CASE
             WHEN v_basis = 0 THEN 0
             WHEN a.bstart::date <= v_cur_bucket THEN 0
             ELSE GREATEST(0, ROUND(v_base + v_trend * a.steps_ahead))
           END AS topups_forecast
    FROM agg a
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'key', to_char(s.bstart, 'YYYY-MM-DD'),
           'label', CASE v_unit
                      WHEN 'month' THEN to_char(s.bstart, 'Mon YYYY')
                      WHEN 'week' THEN 'Wk ' || to_char(s.bstart, 'DD Mon')
                      ELSE to_char(s.bstart, 'DD Mon')
                    END,
           'is_past', (s.bstart::date <= v_today),
           'forecast_returns', s.forecast_returns,
           'forecast_count', s.forecast_count,
           'actual_returns_paid', s.actual_paid,
           'actual_count', s.actual_count,
           'variance', s.actual_paid - s.forecast_returns,
           'partner_receivable', s.partner_receivable,
           'topups', s.topups,
           'topups_forecast', s.topups_forecast,
           'promissory_receivable', s.promissory_receivable,
           'compounding', s.compounding,
           'net', s.partner_receivable
                  + CASE WHEN s.bstart::date <= v_cur_bucket
                         THEN s.topups ELSE s.topups_forecast END
                  + s.promissory_receivable + s.compounding
                  - CASE WHEN s.bstart::date <= v_today
                         THEN s.actual_paid ELSE s.forecast_returns END
         ) ORDER BY s.bstart), '[]'::jsonb)
    INTO v_rows
  FROM shaped s;

  RETURN jsonb_build_object(
    'bucket', v_unit,
    'start', p_start,
    'end', p_end,
    'today', v_today,
    'rows', v_rows,
    'topup_model', jsonb_build_object(
      'basis_buckets', v_basis,
      'baseline_per_bucket', ROUND(COALESCE(v_base,0)),
      'trend_per_bucket', ROUND(COALESCE(v_trend,0))
    ),
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

GRANT EXECUTE ON FUNCTION public.get_partner_ops_returns_forecast(timestamptz, timestamptz, text)
  TO authenticated, service_role;