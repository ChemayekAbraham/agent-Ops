-- General Weekly CFO Report: Monday-to-Sunday week (Kampala time) and ledger-account basis.
-- CFO decision 2026-11-09: the report runs Monday to Sunday.
--
-- Fixes found on 2026-11-09 (read-only check against production):
--   * "Revenue" / "Expenses" summed every platform-scope leg (cash in transit, Supporter funding, wallet withdrawals,
--     float offsets), giving 4.28B / 5.45B for a week whose revenue accounts held 5.8M. Profit and loss now reads the
--     revenue (R*) and expense (X*) accounts through sofp_ledger_legs, the resolver behind the Statement of Financial
--     Position.
--   * Tenant receivables read subscription_charges (no active rows, so 0). Receivables now read the balance-sheet
--     receivable accounts (A3 Rent Plans 456.6M, agent advances A10/A11/A20, and the rest); A4 stays excluded.
--   * Payables read wallet_totals_cache only (149.3M). Payables now read the current liability accounts (L1 wallet
--     custody 862.9M, L4, L5, L6, L7, L8, L3, L9); Supporter capital (L2) is reported separately as non-current.
--   * The landlord float pool (A21/A22) was left out. It is now reported next to cash, as on the treasury card.
--   * The period was a rolling 7 days ending when the page opened, with days cut in UTC.
--
-- Unchanged: cash (A1 + A5) uses the same base-mapping basis and the same row filter as get_treasury_cash_position,
-- so opening and closing cash equal the CFO Home treasury card at the same instants.
--
-- Reporting only: reads the ledger, writes nothing. Signature changes (p_end timestamptz -> p_week_start date), so the
-- old function is dropped and execute is granted again.
-- Rollback: supabase/rollbacks/20261109170000_cfo_weekly_report_mon_sun_ledger_basis.rollback.sql

DROP FUNCTION IF EXISTS public.get_cfo_weekly_report(timestamptz);

CREATE OR REPLACE FUNCTION public.get_cfo_weekly_report(p_week_start date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_tz        constant text := 'Africa/Kampala';
  v_now       timestamptz := now();
  v_this_mon  date := date_trunc('week', (v_now AT TIME ZONE 'Africa/Kampala'))::date;
  v_ws        date;
  v_from      timestamptz;  -- Monday 00:00 Kampala
  v_to        timestamptz;  -- next Monday 00:00 Kampala (exclusive)
  v_end       timestamptz;  -- v_to, or now() for the week in progress
  v_prev_from timestamptz;
  v_out       jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the weekly CFO report';
  END IF;

  -- Default: the last completed Monday-to-Sunday week. Any date is moved back to the Monday of its week.
  v_ws := COALESCE(date_trunc('week', p_week_start::timestamp)::date, v_this_mon - 7);
  IF v_ws > v_this_mon THEN
    RAISE EXCEPTION 'The week starting % has not begun yet', v_ws;
  END IF;

  v_from      := v_ws::timestamp AT TIME ZONE v_tz;
  v_to        := (v_ws + 7)::timestamp AT TIME ZONE v_tz;
  v_end       := LEAST(v_to, v_now);
  v_prev_from := (v_ws - 7)::timestamp AT TIME ZONE v_tz;

  WITH legs AS MATERIALIZED (
    -- Base mapping and row filter identical to get_treasury_cash_position (the CFO Home treasury card).
    SELECT gl.transaction_date,
           gl.category,
           gl.description,
           gl.reference_id,
           gl.direction,
           gl.amount,
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
    WHERE (gl.classification IN ('production','legacy_real')
             OR (gl.classification = 'admin_correction'
                 AND gl.source_table = 'merchant_float_reconciliations'))
      AND gl.transaction_date < v_end
  ), cash AS (
    SELECT transaction_date, category, description, reference_id, account_code, amount,
           CASE WHEN direction = debit_when THEN amount ELSE 0 END AS dr,
           CASE WHEN direction = debit_when THEN 0 ELSE amount END AS cr
    FROM legs
    WHERE account_code IN ('A1','A5','A21','A22')
  ), cash_bal AS (
    SELECT
      COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date < v_from AND account_code IN ('A1','A5')), 0) AS opening_total,
      COALESCE(SUM(dr - cr) FILTER (WHERE account_code IN ('A1','A5')), 0) AS closing_total,
      COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date < v_from AND account_code IN ('A1','A5') AND category = 'treasury_bank_deposit'), 0) AS opening_bank,
      COALESCE(SUM(dr - cr) FILTER (WHERE account_code IN ('A1','A5') AND category = 'treasury_bank_deposit'), 0) AS closing_bank,
      COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date < v_from AND account_code = 'A1'), 0) AS opening_a1,
      COALESCE(SUM(dr - cr) FILTER (WHERE account_code = 'A1'), 0) AS closing_a1,
      COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date < v_from AND account_code = 'A5'), 0) AS opening_a5,
      COALESCE(SUM(dr - cr) FILTER (WHERE account_code = 'A5'), 0) AS closing_a5,
      COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date < v_from AND account_code IN ('A21','A22')), 0) AS opening_pool,
      COALESCE(SUM(dr - cr) FILTER (WHERE account_code IN ('A21','A22')), 0) AS closing_pool
    FROM cash
  ), cash_wk AS (
    SELECT * FROM cash WHERE account_code IN ('A1','A5') AND transaction_date >= v_prev_from
  ), cash_flow AS (
    SELECT
      COALESCE(SUM(dr) FILTER (WHERE transaction_date >= v_from), 0) AS in_cur,
      COALESCE(SUM(cr) FILTER (WHERE transaction_date >= v_from), 0) AS out_cur,
      COUNT(*) FILTER (WHERE transaction_date >= v_from) AS legs_cur,
      COALESCE(SUM(dr) FILTER (WHERE transaction_date < v_from), 0) AS in_prev,
      COALESCE(SUM(cr) FILTER (WHERE transaction_date < v_from), 0) AS out_prev,
      COUNT(*) FILTER (WHERE transaction_date < v_from) AS legs_prev
    FROM cash_wk
  ), daily AS (
    SELECT to_char(transaction_date AT TIME ZONE v_tz, 'YYYY-MM-DD') AS day,
           SUM(dr) AS inflow, SUM(cr) AS outflow
    FROM cash_wk
    WHERE transaction_date >= v_from
    GROUP BY 1
  ), movements AS (
    SELECT category,
           COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date >= v_from), 0) AS net_cur,
           COALESCE(SUM(dr) FILTER (WHERE transaction_date >= v_from), 0) AS in_cur,
           COALESCE(SUM(cr) FILTER (WHERE transaction_date >= v_from), 0) AS out_cur,
           COUNT(*) FILTER (WHERE transaction_date >= v_from) AS count_cur,
           COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date < v_from), 0) AS net_prev,
           COUNT(*) FILTER (WHERE transaction_date < v_from) AS count_prev
    FROM cash_wk
    GROUP BY 1
  ), major AS (
    SELECT transaction_date, category, description, reference_id, amount,
           CASE WHEN dr > 0 THEN 'inflow' ELSE 'outflow' END AS flow
    FROM cash_wk
    WHERE transaction_date >= v_from
    ORDER BY amount DESC
    LIMIT 15
  ), rl AS MATERIALIZED (
    -- Resolved legs: the same account resolution as get_statement_of_financial_position.
    SELECT account_code, category, dr, cr, transaction_date
    FROM public.sofp_ledger_legs(v_end - interval '1 microsecond')
  ), acct AS (
    SELECT account_code,
           SUM(dr - cr) FILTER (WHERE transaction_date < v_from) AS opening_dr,
           SUM(dr - cr) AS closing_dr
    FROM rl
    GROUP BY 1
  ), pl_lines AS (
    SELECT account_code, category,
           SUM(CASE WHEN account_code LIKE 'R%' THEN cr - dr ELSE dr - cr END) FILTER (WHERE transaction_date >= v_from) AS cur,
           SUM(CASE WHEN account_code LIKE 'R%' THEN cr - dr ELSE dr - cr END) FILTER (WHERE transaction_date < v_from) AS prev,
           COUNT(*) FILTER (WHERE transaction_date >= v_from) AS count_cur
    FROM rl
    WHERE transaction_date >= v_prev_from
      AND (account_code LIKE 'R%' OR account_code LIKE 'X%')
    GROUP BY 1, 2
  ), pl AS (
    SELECT
      COALESCE(SUM(cur)  FILTER (WHERE account_code LIKE 'R%'), 0) AS rev_cur,
      COALESCE(SUM(cur)  FILTER (WHERE account_code LIKE 'X%'), 0) AS exp_cur,
      COALESCE(SUM(prev) FILTER (WHERE account_code LIKE 'R%'), 0) AS rev_prev,
      COALESCE(SUM(prev) FILTER (WHERE account_code LIKE 'X%'), 0) AS exp_prev,
      COALESCE(SUM(cur)  FILTER (WHERE account_code = 'X6'), 0) AS x6_cur,
      COALESCE(SUM(prev) FILTER (WHERE account_code = 'X6'), 0) AS x6_prev
    FROM pl_lines
  ), bs AS (
    SELECT a.account_code,
           COALESCE(c.label, a.account_code) AS label,
           CASE WHEN a.account_code LIKE 'L%' THEN 'liability' ELSE 'asset' END AS side,
           CASE WHEN a.account_code LIKE 'L%' THEN -COALESCE(a.opening_dr, 0) ELSE COALESCE(a.opening_dr, 0) END AS opening,
           CASE WHEN a.account_code LIKE 'L%' THEN -COALESCE(a.closing_dr, 0) ELSE COALESCE(a.closing_dr, 0) END AS closing
    FROM acct a
    LEFT JOIN ledger_account_catalog c ON c.code = a.account_code
    WHERE a.account_code LIKE 'A%' OR a.account_code LIKE 'L%'
  ), recv AS (
    SELECT
      COALESCE(SUM(closing) FILTER (WHERE account_code = 'A3'), 0) AS tenant_cl,
      COALESCE(SUM(opening) FILTER (WHERE account_code = 'A3'), 0) AS tenant_op,
      COALESCE(SUM(closing) FILTER (WHERE account_code IN ('A10','A11','A20')), 0) AS adv_cl,
      COALESCE(SUM(opening) FILTER (WHERE account_code IN ('A10','A11','A20')), 0) AS adv_op,
      COALESCE(SUM(closing) FILTER (WHERE account_code NOT IN ('A3','A10','A11','A20')), 0) AS other_cl,
      COALESCE(SUM(opening) FILTER (WHERE account_code NOT IN ('A3','A10','A11','A20')), 0) AS other_op
    FROM bs
    WHERE account_code IN ('A3','A6','A7','A10','A11','A12','A13','A14','A15','A16','A17','A18','A19','A20','A23','A24','A25')
  ), ca AS (
    SELECT
      COALESCE(SUM(closing) FILTER (WHERE side = 'asset'), 0) AS assets_cl,
      COALESCE(SUM(opening) FILTER (WHERE side = 'asset'), 0) AS assets_op,
      COALESCE(SUM(closing) FILTER (WHERE side = 'liability' AND account_code <> 'L2'), 0) AS liab_cl,
      COALESCE(SUM(opening) FILTER (WHERE side = 'liability' AND account_code <> 'L2'), 0) AS liab_op,
      COALESCE(SUM(closing) FILTER (WHERE account_code = 'L1'), 0) AS l1_cl,
      COALESCE(SUM(closing) FILTER (WHERE account_code = 'L2'), 0) AS l2_cl,
      COALESCE(SUM(opening) FILTER (WHERE account_code = 'L2'), 0) AS l2_op
    FROM bs
  ), pend AS (
    SELECT COALESCE(SUM(amount), 0) AS amt, COUNT(*) AS n
    FROM pending_wallet_operations WHERE status = 'pending'
  )
  SELECT jsonb_build_object(
    'generated_at', v_now,
    'currency', 'UGX',
    'timezone', v_tz,
    'period', jsonb_build_object('from', v_from, 'to', v_end, 'days', 7, 'week_start', v_ws, 'week_end', v_ws + 6,
                                 'complete', v_end = v_to),
    'previous_period', jsonb_build_object('from', v_prev_from, 'to', v_from, 'days', 7, 'week_start', v_ws - 7, 'week_end', v_ws - 1,
                                          'complete', true),
    'basis', 'Monday to Sunday, Kampala time. Cash = A1 Cash and Bank + A5 Cash in Transit, the same basis as the CFO Home treasury card; landlord float pool (A21 + A22) shown separately. Revenue, expenses, receivables and payables are the ledger accounts used by the Statement of Financial Position (R, X, A and L accounts). General ledger, production and legacy_real entries.',
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
        'closing_a5', ROUND(closing_a5),
        'opening_pool', ROUND(opening_pool),
        'closing_pool', ROUND(closing_pool),
        'opening_incl_pool', ROUND(opening_total + opening_pool),
        'closing_incl_pool', ROUND(closing_total + closing_pool)
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
        'prev_net_margin', CASE WHEN rev_prev > 0 THEN ROUND(((rev_prev - exp_prev) / rev_prev) * 100, 1) ELSE 0 END,
        'float_restatement', ROUND(x6_cur), 'prev_float_restatement', ROUND(x6_prev)
      ) FROM pl
    ),
    'revenue_lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('category', category, 'account_code', account_code, 'amount', ROUND(COALESCE(cur, 0)),
                                          'prev_amount', ROUND(COALESCE(prev, 0)), 'count', count_cur) ORDER BY COALESCE(cur, 0) DESC)
      FROM pl_lines WHERE account_code LIKE 'R%' AND (COALESCE(cur, 0) <> 0 OR COALESCE(prev, 0) <> 0)), '[]'::jsonb),
    'expense_lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('category', category, 'account_code', account_code, 'amount', ROUND(COALESCE(cur, 0)),
                                          'prev_amount', ROUND(COALESCE(prev, 0)), 'count', count_cur) ORDER BY COALESCE(cur, 0) DESC)
      FROM pl_lines WHERE account_code LIKE 'X%' AND (COALESCE(cur, 0) <> 0 OR COALESCE(prev, 0) <> 0)), '[]'::jsonb),
    'receivables', (
      SELECT jsonb_build_object(
        'tenant_outstanding', ROUND(tenant_cl),
        'opening_tenant_outstanding', ROUND(tenant_op),
        'advances_outstanding', ROUND(adv_cl),
        'opening_advances_outstanding', ROUND(adv_op),
        'advances_active_count', (SELECT COUNT(*) FROM agent_advances WHERE status = 'active'),
        'other', ROUND(other_cl),
        'opening_other', ROUND(other_op),
        'total', ROUND(tenant_cl + adv_cl + other_cl),
        'opening_total', ROUND(tenant_op + adv_op + other_op),
        'lines', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('account_code', account_code, 'label', label,
                                              'opening', ROUND(opening), 'closing', ROUND(closing)) ORDER BY abs(closing) DESC)
          FROM bs
          WHERE account_code IN ('A3','A6','A7','A10','A11','A12','A13','A14','A15','A16','A17','A18','A19','A20','A23','A24','A25')
            AND (round(opening) <> 0 OR round(closing) <> 0)), '[]'::jsonb)
      ) FROM recv
    ),
    'payables', (
      SELECT jsonb_build_object(
        'wallet_total', ROUND(ca.l1_cl),
        'total', ROUND(ca.liab_cl),
        'opening_total', ROUND(ca.liab_op),
        'supporter_capital', ROUND(ca.l2_cl),
        'opening_supporter_capital', ROUND(ca.l2_op),
        'pending_operations_amount', ROUND(pend.amt),
        'pending_operations_count', pend.n,
        'lines', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('account_code', account_code, 'label', label,
                                              'opening', ROUND(opening), 'closing', ROUND(closing)) ORDER BY abs(closing) DESC)
          FROM bs
          WHERE side = 'liability' AND account_code <> 'L2'
            AND (round(opening) <> 0 OR round(closing) <> 0)), '[]'::jsonb)
      ) FROM ca, pend
    ),
    'position', (
      SELECT jsonb_build_object(
        'money_we_have', ROUND(cb.closing_total),
        'money_in_treasury', ROUND(cb.closing_total - cb.closing_bank),
        'money_in_bank', ROUND(cb.closing_bank),
        'landlord_pool', ROUND(cb.closing_pool),
        'money_we_owe', ROUND(ca.liab_cl),
        'money_we_can_use', ROUND(GREATEST(0, cb.closing_total - ca.liab_cl)),
        'receivables', ROUND(r.tenant_cl + r.adv_cl + r.other_cl),
        'current_assets', ROUND(ca.assets_cl),
        'current_liabilities', ROUND(ca.liab_cl),
        'net_working_capital', ROUND(ca.assets_cl - ca.liab_cl),
        'opening_net_working_capital', ROUND(ca.assets_op - ca.liab_op)
      ) FROM cash_bal cb, ca, recv r
    )
  )
  INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_cfo_weekly_report(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_cfo_weekly_report(date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_weekly_report(date) TO authenticated, service_role;
