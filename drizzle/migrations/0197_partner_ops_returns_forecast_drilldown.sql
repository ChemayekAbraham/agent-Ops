CREATE OR REPLACE FUNCTION public.get_partner_ops_returns_forecast_detail(
  p_period date,
  p_metric text,
  p_bucket text DEFAULT 'month',
  p_limit int DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_tz text := 'Africa/Kampala';
  v_unit text;
  v_metric text := lower(coalesce(p_metric,''));
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 300), 1), 1000);
  v_bstart timestamp;
  v_bend timestamp;
  v_rows jsonb := '[]'::jsonb;
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

  v_bstart := date_trunc(v_unit, p_period::timestamp);
  v_bend := v_bstart + ('1 ' || v_unit)::interval;

  IF v_metric = 'forecast' THEN
    WITH pf AS (
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
    due AS (
      SELECT pf.id, pf.investor_id, pf.investment_amount, pf.roi_percentage, pf.status,
             pf.started_on, pf.maturity_date,
             (pf.anchor_date + (n || ' month')::interval)::date AS due_date,
             ROUND(pf.investment_amount * pf.roi_percentage / 100.0) AS amount
      FROM pf CROSS JOIN generate_series(-48, 48) AS n
      WHERE pf.anchor_date IS NOT NULL
    )
    SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'record_id', d.id,
               'subject_id', d.investor_id,
               'name', COALESCE(pr.full_name, 'Supporter'),
               'detail', 'Portfolio ' || left(d.id::text, 8) || ' · ' ||
                         formatted.pct || '% of ' || to_char(d.investment_amount, 'FM999,999,999,999'),
               'amount', d.amount,
               'occurred_on', d.due_date,
               'status', d.status,
               'source', 'investor_portfolios'
             ) AS r
      FROM due d
      LEFT JOIN profiles pr ON pr.id = d.investor_id
      CROSS JOIN LATERAL (SELECT to_char(d.roi_percentage, 'FM990.99') AS pct) formatted
      WHERE d.due_date >= d.started_on
        AND (d.maturity_date IS NULL OR d.due_date <= d.maturity_date)
        AND d.due_date >= v_bstart::date
        AND d.due_date < v_bend::date
      LIMIT v_limit
    ) s;

  ELSIF v_metric IN ('actual','compounding','topups') THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'record_id', gl.id,
               'subject_id', gl.user_id,
               'name', COALESCE(pr.full_name, 'Platform'),
               'detail', COALESCE(NULLIF(gl.description, ''), gl.category)
                         || COALESCE(' · ref ' || NULLIF(gl.reference_id, ''), ''),
               'amount', gl.amount,
               'occurred_on', (gl.transaction_date AT TIME ZONE v_tz)::date,
               'status', gl.category,
               'source', 'general_ledger'
             ) AS r
      FROM general_ledger gl
      LEFT JOIN profiles pr ON pr.id = gl.user_id
      WHERE gl.ledger_scope = 'platform'
        AND gl.classification <> 'admin_correction'
        AND gl.category = CASE v_metric
                            WHEN 'actual' THEN 'roi_expense'
                            WHEN 'compounding' THEN 'roi_reinvestment'
                            ELSE 'pending_portfolio_topup'
                          END
        AND gl.direction = CASE v_metric WHEN 'actual' THEN 'cash_out' ELSE 'cash_in' END
        AND (gl.transaction_date AT TIME ZONE v_tz) >= v_bstart
        AND (gl.transaction_date AT TIME ZONE v_tz) < v_bend
      LIMIT v_limit
    ) s;

  ELSIF v_metric = 'receivable' THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'record_id', ip.id,
               'subject_id', ip.investor_id,
               'name', COALESCE(pr.full_name, 'Supporter'),
               'detail', 'Portfolio ' || left(ip.id::text, 8) || ' awaiting approval',
               'amount', ip.investment_amount,
               'occurred_on', (ip.created_at AT TIME ZONE v_tz)::date,
               'status', ip.status,
               'source', 'investor_portfolios'
             ) AS r
      FROM investor_portfolios ip
      LEFT JOIN profiles pr ON pr.id = ip.investor_id
      WHERE ip.status IN ('pending','pending_approval')
        AND COALESCE(ip.investment_amount,0) > 0
        AND (ip.created_at AT TIME ZONE v_tz) >= v_bstart
        AND (ip.created_at AT TIME ZONE v_tz) < v_bend
      LIMIT v_limit
    ) s;

  ELSIF v_metric = 'promissory' THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'record_id', pn.id,
               'subject_id', pn.agent_id,
               'name', COALESCE(pr.full_name, 'Agent'),
               'detail', 'Promissory note ' || left(pn.id::text, 8),
               'amount', pn.amount,
               'occurred_on', COALESCE(pn.fulfilment_due_on, pn.next_deduction_date,
                                       pn.recorded_on, (pn.created_at AT TIME ZONE v_tz)::date),
               'status', pn.status,
               'source', 'promissory_notes'
             ) AS r
      FROM promissory_notes pn
      LEFT JOIN profiles pr ON pr.id = pn.agent_id
      WHERE pn.status = 'pending'
        AND COALESCE(pn.amount,0) > 0
        AND COALESCE(pn.fulfilment_due_on, pn.next_deduction_date,
                     pn.recorded_on, (pn.created_at AT TIME ZONE v_tz)::date) >= v_bstart::date
        AND COALESCE(pn.fulfilment_due_on, pn.next_deduction_date,
                     pn.recorded_on, (pn.created_at AT TIME ZONE v_tz)::date) < v_bend::date
      LIMIT v_limit
    ) s;

  ELSE
    RAISE EXCEPTION 'Unknown metric %', p_metric;
  END IF;

  RETURN jsonb_build_object(
    'metric', v_metric,
    'bucket', v_unit,
    'period', to_char(v_bstart, 'YYYY-MM-DD'),
    'count', jsonb_array_length(v_rows),
    'total', COALESCE((SELECT SUM((e->>'amount')::numeric) FROM jsonb_array_elements(v_rows) e), 0),
    'truncated', jsonb_array_length(v_rows) >= v_limit,
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_partner_ops_returns_forecast_detail(date, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_partner_ops_returns_forecast_detail(date, text, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_ops_returns_forecast_detail(date, text, text, int) TO service_role;