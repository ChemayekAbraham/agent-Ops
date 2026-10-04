CREATE OR REPLACE FUNCTION public.get_cfo_weekly_report(p_end timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_end timestamptz := COALESCE(p_end, now());
  v_from timestamptz;
  v_prev_from timestamptz;
  v_out jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the weekly CFO report';
  END IF;

  v_from      := v_end - interval '7 days';
  v_prev_from := v_end - interval '14 days';

  WITH legs AS MATERIALIZED (
    SELECT gl.id,
           gl.transaction_date,
           gl.category,
           gl.description,
           gl.reference_id,
           gl.direction,
           gl.amount,
           gl.ledger_scope,
           COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'float'   THEN 'A2'
                  WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'advance' THEN 'A4'
                  WHEN gl.ledger_scope = 'wallet'                                  THEN 'L1'
                  ELSE 'A9' END) AS account_code,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope = 'wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS debit_when
    FROM general_ledger gl
    LEFT JOIN ledger_account_map mb
           ON mb.ledger_scope = gl.ledger_scope
          AND mb.category     = gl.category
          AND mb.wallet_bucket IS NOT NULL
          AND mb.wallet_bucket = gl.wallet_bucket
    LEFT JOIN ledger_account_map mw
           ON mw.ledger_scope = gl.ledger_scope
          AND mw.category     = gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.classification IN ('production','legacy_real')
      AND gl.transaction_date <= v_end
  ), cash AS (
    SELECT id, transaction_date, category, description, reference_id, account_code,
           CASE WHEN direction = debit_when THEN amount ELSE 0 END AS dr,
           CASE WHEN direction = debit_when THEN 0 ELSE amount END AS cr,
           amount
    FROM legs
    WHERE account_code IN ('A1','A5')
  ), cash_bal AS (
    SELECT
      COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date <  v_from), 0) AS opening_total,
      COALESCE(SUM(dr - cr), 0) AS closing_total,
      COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date <  v_from AND category = 'treasury_bank_deposit'), 0) AS opening_bank,
      COALESCE(SUM(dr - cr) FILTER (WHERE category = 'treasury_bank_deposit'), 0) AS closing_bank,
      COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date <  v_from AND account_code = 'A1'), 0) AS opening_a1,
      COALESCE(SUM(dr - cr) FILTER (WHERE account_code = 'A1'), 0) AS closing_a1,
      COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date <  v_from AND account_code = 'A5'), 0) AS opening_a5,
      COALESCE(SUM(dr - cr) FILTER (WHERE account_code = 'A5'), 0) AS closing_a5
    FROM cash
  ), cash_flow AS (
    SELECT
      COALESCE(SUM(dr) FILTER (WHERE transaction_date >= v_from), 0) AS in_cur,
      COALESCE(SUM(cr) FILTER (WHERE transaction_date >= v_from), 0) AS out_cur,
      COUNT(*) FILTER (WHERE transaction_date >= v_from) AS legs_cur,
      COALESCE(SUM(dr) FILTER (WHERE transaction_date >= v_prev_from AND transaction_date < v_from), 0) AS in_prev,
      COALESCE(SUM(cr) FILTER (WHERE transaction_date >= v_prev_from AND transaction_date < v_from), 0) AS out_prev,
      COUNT(*) FILTER (WHERE transaction_date >= v_prev_from AND transaction_date < v_from) AS legs_prev
    FROM cash
  ), daily AS (
    SELECT to_char(date_trunc('day', transaction_date), 'YYYY-MM-DD') AS day,
           SUM(dr) AS inflow, SUM(cr) AS outflow
    FROM cash
    WHERE transaction_date >= v_from
    GROUP BY 1
  ), movements AS (
    SELECT category,
           COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date >= v_from), 0) AS net_cur,
           COALESCE(SUM(dr) FILTER (WHERE transaction_date >= v_from), 0) AS in_cur,
           COALESCE(SUM(cr) FILTER (WHERE transaction_date >= v_from), 0) AS out_cur,
           COUNT(*) FILTER (WHERE transaction_date >= v_from) AS count_cur,
           COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date >= v_prev_from AND transaction_date < v_from), 0) AS net_prev,
           COUNT(*) FILTER (WHERE transaction_date >= v_prev_from AND transaction_date < v_from) AS count_prev
    FROM cash
    WHERE transaction_date >= v_prev_from
    GROUP BY 1
  ), major AS (
    SELECT transaction_date, category, description, reference_id,
           amount, dr, cr,
           CASE WHEN dr > 0 THEN 'inflow' ELSE 'outflow' END AS flow
    FROM cash
    WHERE transaction_date >= v_from
    ORDER BY amount DESC
    LIMIT 15
  ), pl AS (
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE direction = 'cash_in'  AND transaction_date >= v_from), 0) AS rev_cur,
      COALESCE(SUM(amount) FILTER (WHERE direction = 'cash_out' AND transaction_date >= v_from), 0) AS exp_cur,
      COALESCE(SUM(amount) FILTER (WHERE direction = 'cash_in'  AND transaction_date >= v_prev_from AND transaction_date < v_from), 0) AS rev_prev,
      COALESCE(SUM(amount) FILTER (WHERE direction = 'cash_out' AND transaction_date >= v_prev_from AND transaction_date < v_from), 0) AS exp_prev
    FROM legs
    WHERE ledger_scope = 'platform'
      AND category <> 'opening_balance'
      AND transaction_date >= v_prev_from
  ), pl_lines AS (
    SELECT direction, category,
           COALESCE(SUM(amount) FILTER (WHERE transaction_date >= v_from), 0) AS cur,
           COALESCE(SUM(amount) FILTER (WHERE transaction_date >= v_prev_from AND transaction_date < v_from), 0) AS prev,
           COUNT(*) FILTER (WHERE transaction_date >= v_from) AS count_cur
    FROM legs
    WHERE ledger_scope = 'platform'
      AND category <> 'opening_balance'
      AND transaction_date >= v_prev_from
    GROUP BY 1, 2
  ), recv AS (
    SELECT
      COALESCE((SELECT SUM(accumulated_debt) FROM subscription_charges WHERE status = 'active'), 0) AS tenant_outstanding,
      COALESCE((SELECT SUM(outstanding_balance) FROM agent_advances WHERE status = 'active'), 0) AS advances_outstanding,
      COALESCE((SELECT COUNT(*) FROM agent_advances WHERE status = 'active'), 0) AS advances_active_count
  ), pay AS (
    SELECT
      COALESCE((SELECT total_balance      FROM wallet_totals_cache WHERE id = 1), 0) AS wallet_total,
      COALESCE((SELECT total_withdrawable FROM wallet_totals_cache WHERE id = 1), 0) AS wallet_withdrawable,
      COALESCE((SELECT total_float        FROM wallet_totals_cache WHERE id = 1), 0) AS wallet_float,
      COALESCE((SELECT SUM(amount) FROM pending_wallet_operations WHERE status = 'pending'), 0) AS pending_ops_amount,
      COALESCE((SELECT COUNT(*)    FROM pending_wallet_operations WHERE status = 'pending'), 0) AS pending_ops_count
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'currency', 'UGX',
    'period', jsonb_build_object('from', v_from, 'to', v_end, 'days', 7),
    'previous_period', jsonb_build_object('from', v_prev_from, 'to', v_from, 'days', 7),
    'basis', 'General ledger (classification production + legacy_real). Cash = A1 Cash and Bank + A5 Cash in Transit, identical to the CFO Home cash cards.',
    'cash', (
      SELECT jsonb_build_object(
        'opening_cash', ROUND(opening_total),
        'closing_cash', ROUND(closing_total),
        'net_change', ROUND(closing_total - opening_total),
        'opening_bank', ROUND(opening_bank),
        'closing_bank', ROUND(closing_bank),
        'opening_treasury', ROUND(opening_total - opening_bank),
        'closing_treasury', ROUND(closing_total - closing_bank),
        'opening_a1', ROUND(opening_a1),
        'closing_a1', ROUND(closing_a1),
        'opening_a5', ROUND(opening_a5),
        'closing_a5', ROUND(closing_a5)
      ) FROM cash_bal
    ),
    'cash_flow', (
      SELECT jsonb_build_object(
        'inflows', ROUND(in_cur), 'outflows', ROUND(out_cur), 'net', ROUND(in_cur - out_cur), 'legs', legs_cur,
        'prev_inflows', ROUND(in_prev), 'prev_outflows', ROUND(out_prev), 'prev_net', ROUND(in_prev - out_prev), 'prev_legs', legs_prev
      ) FROM cash_flow
    ),
    'daily_flow', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('day', day, 'inflow', ROUND(inflow), 'outflow', ROUND(outflow),
                                          'net', ROUND(inflow - outflow)) ORDER BY day)
      FROM daily), '[]'::jsonb),
    'movements', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'category', category, 'net', ROUND(net_cur), 'inflow', ROUND(in_cur), 'outflow', ROUND(out_cur),
               'count', count_cur, 'prev_net', ROUND(net_prev), 'prev_count', count_prev,
               'delta', ROUND(net_cur - net_prev)
             ) ORDER BY abs(net_cur) DESC)
      FROM movements WHERE count_cur > 0 OR count_prev > 0), '[]'::jsonb),
    'major_transactions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'date', transaction_date, 'category', category, 'description', description,
               'reference', reference_id, 'amount', ROUND(amount), 'flow', flow) ORDER BY amount DESC)
      FROM major), '[]'::jsonb),
    'profit_and_loss', (
      SELECT jsonb_build_object(
        'revenue', ROUND(rev_cur), 'expenses', ROUND(exp_cur), 'net_result', ROUND(rev_cur - exp_cur),
        'net_margin', CASE WHEN rev_cur > 0 THEN ROUND(((rev_cur - exp_cur) / rev_cur) * 100, 1) ELSE 0 END,
        'prev_revenue', ROUND(rev_prev), 'prev_expenses', ROUND(exp_prev),
        'prev_net_result', ROUND(rev_prev - exp_prev),
        'prev_net_margin', CASE WHEN rev_prev > 0 THEN ROUND(((rev_prev - exp_prev) / rev_prev) * 100, 1) ELSE 0 END
      ) FROM pl
    ),
    'revenue_lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('category', category, 'amount', ROUND(cur), 'prev_amount', ROUND(prev),
                                          'count', count_cur) ORDER BY cur DESC)
      FROM pl_lines WHERE direction = 'cash_in' AND (cur > 0 OR prev > 0)), '[]'::jsonb),
    'expense_lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('category', category, 'amount', ROUND(cur), 'prev_amount', ROUND(prev),
                                          'count', count_cur) ORDER BY cur DESC)
      FROM pl_lines WHERE direction = 'cash_out' AND (cur > 0 OR prev > 0)), '[]'::jsonb),
    'receivables', (
      SELECT jsonb_build_object(
        'tenant_outstanding', ROUND(tenant_outstanding),
        'advances_outstanding', ROUND(advances_outstanding),
        'advances_active_count', advances_active_count,
        'total', ROUND(tenant_outstanding + advances_outstanding)
      ) FROM recv
    ),
    'payables', (
      SELECT jsonb_build_object(
        'wallet_total', ROUND(wallet_total),
        'wallet_withdrawable', ROUND(wallet_withdrawable),
        'wallet_float', ROUND(wallet_float),
        'pending_operations_amount', ROUND(pending_ops_amount),
        'pending_operations_count', pending_ops_count,
        'total', ROUND(wallet_total)
      ) FROM pay
    ),
    'position', (
      SELECT jsonb_build_object(
        'money_we_have', ROUND(cb.closing_total),
        'money_in_treasury', ROUND(cb.closing_total - cb.closing_bank),
        'money_in_bank', ROUND(cb.closing_bank),
        'money_we_owe', ROUND(p.wallet_total),
        'money_we_can_use', ROUND(GREATEST(0, cb.closing_total - p.wallet_total)),
        'receivables', ROUND(r.tenant_outstanding + r.advances_outstanding),
        'net_working_capital', ROUND(cb.closing_total + r.tenant_outstanding + r.advances_outstanding - p.wallet_total)
      ) FROM cash_bal cb, pay p, recv r
    )
  )
  INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_cfo_weekly_report(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cfo_weekly_report(timestamptz) TO authenticated, service_role;