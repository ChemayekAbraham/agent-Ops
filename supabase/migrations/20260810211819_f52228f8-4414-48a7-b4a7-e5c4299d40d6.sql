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
  ), fa AS (
    SELECT bstart, SUM(amount) AS amount, COUNT(*) AS cnt FROM f GROUP BY bstart
  )
  SELECT jsonb_build_array(jsonb_build_object(
           'key', 'roi_forecast',
           'label', 'Forecasted Returns (Partner Ops portfolios)',
           'kind', 'forecast',
           'flow', 'out',
           'total', COALESCE((SELECT SUM(amount) FROM fa), 0),
           'count', COALESCE((SELECT SUM(cnt) FROM fa), 0),
           'points', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', to_char(bstart, 'YYYY-MM-DD'),
                      'amount', amount,
                      'count', cnt
                    ) ORDER BY bstart)
             FROM fa
           ), '[]'::jsonb)
         ))
    INTO v_cats;

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
           COUNT(DISTINCT w.id) AS portfolios
    FROM w GROUP BY w.investor_id
  ), committed AS (
    SELECT investor_id, SUM(investment_amount) AS committed FROM pf GROUP BY investor_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'partner_id', byp.investor_id,
           'partner_name', COALESCE(pr.full_name, 'Partner'),
           'phone', pr.phone,
           'portfolios', byp.portfolios,
           'committed', COALESCE(c.committed, 0),
           'payouts', byp.payouts,
           'next_due', byp.next_due,
           'projected', byp.projected
         ) ORDER BY byp.projected DESC), '[]'::jsonb)
    INTO v_partners
  FROM byp
  LEFT JOIN committed c ON c.investor_id = byp.investor_id
  LEFT JOIN profiles pr ON pr.id = byp.investor_id;

  WITH w AS (
    SELECT date_trunc(v_unit, wr.created_at AT TIME ZONE v_tz) AS bstart, wr.amount
    FROM withdrawal_requests wr
    WHERE wr.status NOT IN ('completed','rejected','cancelled','failed')
      AND wr.created_at >= p_start AND wr.created_at < p_end
  ), wa AS (
    SELECT bstart, SUM(amount) AS amount, COUNT(*) AS cnt FROM w GROUP BY bstart
  )
  SELECT v_cats || jsonb_build_array(jsonb_build_object(
           'key', 'withdrawals_queued',
           'label', 'Queued withdrawals (pipeline)',
           'kind', 'forecast',
           'flow', 'out',
           'total', COALESCE((SELECT SUM(amount) FROM wa), 0),
           'count', COALESCE((SELECT SUM(cnt) FROM wa), 0),
           'points', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', to_char(bstart, 'YYYY-MM-DD'),
                      'amount', amount,
                      'count', cnt
                    ) ORDER BY bstart)
             FROM wa
           ), '[]'::jsonb)
         ))
    INTO v_cats;

  WITH rr AS (
    SELECT r.id,
           GREATEST(COALESCE(r.daily_repayment, 0), 0) AS daily,
           GREATEST(COALESCE(r.total_repayment, 0) - COALESCE(r.amount_repaid, 0), 0) AS remaining
    FROM rent_requests r
    WHERE r.status IN ('funded','repaying','active','disbursed')
      AND COALESCE(r.tenancy_status, 'active') <> 'ended'
      AND COALESCE(r.agent_payment_status, 'paying') <> 'not_paying'
      AND COALESCE(r.daily_repayment, 0) > 0
      AND COALESCE(r.total_repayment, 0) - COALESCE(r.amount_repaid, 0) > 0
  ), sched AS (
    SELECT rr.id,
           ((now() AT TIME ZONE v_tz)::date + n) AS due_date,
           LEAST(rr.daily, rr.remaining - (rr.daily * n)) AS amount
    FROM rr
    CROSS JOIN generate_series(0, 400) AS n
    WHERE (rr.daily * n) < rr.remaining
  ), w AS (
    SELECT date_trunc(v_unit, due_date::timestamp) AS bstart, amount
    FROM sched
    WHERE due_date >= (p_start AT TIME ZONE v_tz)::date
      AND due_date <  (p_end AT TIME ZONE v_tz)::date
      AND amount > 0
  ), ra AS (
    SELECT bstart, SUM(amount) AS amount, COUNT(*) AS cnt FROM w GROUP BY bstart
  )
  SELECT v_cats || jsonb_build_array(jsonb_build_object(
           'key', 'rent_receivables_forecast',
           'label', 'Expected tenant repayments (receivables)',
           'kind', 'forecast',
           'flow', 'in',
           'total', COALESCE((SELECT SUM(amount) FROM ra), 0),
           'count', COALESCE((SELECT SUM(cnt) FROM ra), 0),
           'points', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', to_char(bstart, 'YYYY-MM-DD'),
                      'amount', amount,
                      'count', cnt
                    ) ORDER BY bstart)
             FROM ra
           ), '[]'::jsonb)
         ))
    INTO v_cats;

  WITH ad AS (
    SELECT a.id,
           GREATEST(COALESCE(NULLIF(a.daily_installment, 0), a.installment_amount, 0), 0) AS daily,
           GREATEST(COALESCE(a.outstanding_balance, 0), 0) AS remaining
    FROM agent_advances a
    WHERE a.status IN ('active','disbursed','repaying')
      AND COALESCE(a.deduction_paused, false) = false
      AND COALESCE(a.outstanding_balance, 0) > 0
      AND COALESCE(NULLIF(a.daily_installment, 0), a.installment_amount, 0) > 0
  ), sched AS (
    SELECT ad.id,
           ((now() AT TIME ZONE v_tz)::date + n) AS due_date,
           LEAST(ad.daily, ad.remaining - (ad.daily * n)) AS amount
    FROM ad CROSS JOIN generate_series(0, 400) AS n
    WHERE (ad.daily * n) < ad.remaining
  ), w AS (
    SELECT date_trunc(v_unit, due_date::timestamp) AS bstart, amount
    FROM sched
    WHERE due_date >= (p_start AT TIME ZONE v_tz)::date
      AND due_date <  (p_end AT TIME ZONE v_tz)::date
      AND amount > 0
  ), aa AS (
    SELECT bstart, SUM(amount) AS amount, COUNT(*) AS cnt FROM w GROUP BY bstart
  )
  SELECT v_cats || jsonb_build_array(jsonb_build_object(
           'key', 'advance_recovery_forecast',
           'label', 'Expected agent advance recoveries',
           'kind', 'forecast',
           'flow', 'in',
           'total', COALESCE((SELECT SUM(amount) FROM aa), 0),
           'count', COALESCE((SELECT SUM(cnt) FROM aa), 0),
           'points', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', to_char(bstart, 'YYYY-MM-DD'),
                      'amount', amount,
                      'count', cnt
                    ) ORDER BY bstart)
             FROM aa
           ), '[]'::jsonb)
         ))
    INTO v_cats;

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
             'flow', 'out',
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

  WITH src AS (
    SELECT gl.category,
           date_trunc(v_unit, gl.transaction_date AT TIME ZONE v_tz) AS bstart,
           gl.amount
    FROM general_ledger gl
    WHERE gl.direction = 'cash_in'
      AND gl.transaction_date >= p_start AND gl.transaction_date < p_end
      AND gl.classification <> 'admin_correction'
      AND gl.category <> 'system_balance_correction'
      AND gl.category IN (
        'tenant_repayment','rent_principal_collected','agent_repayment','partner_funding',
        'wallet_deposit','share_capital','access_fee_collected','registration_fee_collected',
        'debt_recovery','platform_service_income','tenant_default_charge','roi_reinvestment'
      )
  ), agg AS (
    SELECT category, bstart, SUM(amount) AS amount, COUNT(*) AS cnt
    FROM src GROUP BY category, bstart
  )
  SELECT v_cats || COALESCE(jsonb_agg(c ORDER BY (c->>'total')::numeric DESC), '[]'::jsonb)
    INTO v_cats
  FROM (
    SELECT jsonb_build_object(
             'key', 'in_' || category,
             'label', initcap(replace(category, '_', ' ')),
             'kind', 'actual',
             'flow', 'in',
             'total', SUM(amount),
             'count', SUM(cnt),
             'points', jsonb_agg(jsonb_build_object(
                         'key', to_char(bstart, 'YYYY-MM-DD'),
                         'amount', amount,
                         'count', cnt
                       ) ORDER BY bstart)
           ) AS c
    FROM agg GROUP BY category
  ) y;

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