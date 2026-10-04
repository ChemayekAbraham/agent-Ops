CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position(p_as_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_dr numeric := 0;
  v_cr numeric := 0;
  v_sections jsonb := '{}'::jsonb;
  v_revenue numeric := 0;
  v_expenses numeric := 0;
  v_retained numeric := 0;
  v_tca numeric := 0; v_tnca numeric := 0; v_ta numeric := 0;
  v_tcl numeric := 0; v_tncl numeric := 0; v_tl numeric := 0;
  v_te numeric := 0; v_residual numeric := 0;
  v_assets_current jsonb; v_assets_non_current jsonb;
  v_liab_current jsonb; v_liab_non_current jsonb; v_equity jsonb;
  v_unresolved jsonb; v_unresolved_groups bigint := 0; v_unresolved_abs numeric := 0;
  v_excluded jsonb; v_memo jsonb;
  v_balanced boolean;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the statement of financial position';
  END IF;

  -- Classification filtering is applied at TRANSACTION GROUP granularity, never per leg.
  -- A group is reportable when at least one of its legs carries a reportable
  -- classification ('production' or 'legacy_real'); all of that group's legs are then
  -- included, so the counterpart of a balanced two-sided entry can never be dropped.
  -- Groups whose every leg is excluded (e.g. pure admin_correction / test_dev groups)
  -- are excluded in full. Legs with no group id fall back to leg-level filtering.
  WITH grp_class AS MATERIALIZED (
    SELECT transaction_group_id,
           bool_or(classification IN ('production','legacy_real')) AS has_reportable,
           bool_or(classification NOT IN ('production','legacy_real')) AS has_excluded
    FROM general_ledger
    WHERE transaction_group_id IS NOT NULL
    GROUP BY transaction_group_id
  ), legs AS MATERIALIZED (
    SELECT gl.transaction_group_id,
           gl.ledger_scope,
           gl.category,
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
    LEFT JOIN grp_class g ON g.transaction_group_id = gl.transaction_group_id
    LEFT JOIN ledger_account_map mb
           ON mb.ledger_scope = gl.ledger_scope
          AND mb.category     = gl.category
          AND mb.wallet_bucket IS NOT NULL
          AND mb.wallet_bucket = gl.wallet_bucket
    LEFT JOIN ledger_account_map mw
           ON mw.ledger_scope = gl.ledger_scope
          AND mw.category     = gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.transaction_date <= p_as_at
      AND CASE
            WHEN gl.transaction_group_id IS NULL
              THEN gl.classification IN ('production','legacy_real')
            ELSE COALESCE(g.has_reportable, false)
          END
  ), l AS MATERIALIZED (
    SELECT transaction_group_id, ledger_scope, category, account_code,
           CASE WHEN direction = debit_when THEN amount ELSE 0 END AS dr,
           CASE WHEN direction = debit_when THEN 0 ELSE amount END AS cr
    FROM legs
  ), bal AS (
    SELECT l.account_code, SUM(l.dr) dr, SUM(l.cr) cr FROM l GROUP BY 1
  ), signed AS (
    SELECT c.code, c.label, c.section, c.nature, c.sort_order,
           CASE WHEN c.nature IN ('asset','expense') THEN COALESCE(b.dr,0) - COALESCE(b.cr,0)
                ELSE COALESCE(b.cr,0) - COALESCE(b.dr,0) END AS value,
           COALESCE(b.dr,0) dr, COALESCE(b.cr,0) cr
    FROM ledger_account_catalog c
    LEFT JOIN bal b ON b.account_code = c.code
  ), sect AS (
    SELECT section,
           jsonb_agg(jsonb_build_object(
             'label', label, 'value', value,
             'source', 'general_ledger trial balance — account ' || code
           ) ORDER BY sort_order) lines,
           SUM(dr) dr_t, SUM(cr) cr_t
    FROM signed
    GROUP BY section
  ), grp AS (
    SELECT transaction_group_id, SUM(dr) - SUM(cr) resid FROM l GROUP BY 1
  ), u AS (
    SELECT * FROM grp WHERE abs(resid) > 0.5
  ), sched AS (
    SELECT jsonb_build_object(
             'ledger_scope', l.ledger_scope,
             'category', l.category,
             'groups', COUNT(DISTINCT l.transaction_group_id),
             'net_debit_less_credit', ROUND(SUM(l.dr - l.cr))
           ) x
    FROM l
    JOIN u ON u.transaction_group_id = l.transaction_group_id
    GROUP BY l.ledger_scope, l.category
    HAVING abs(SUM(l.dr - l.cr)) > 0.5
    ORDER BY abs(SUM(l.dr - l.cr)) DESC
    LIMIT 25
  )
  SELECT (SELECT jsonb_object_agg(section, lines) FROM sect),
         (SELECT COALESCE(SUM(dr_t),0) FROM sect),
         (SELECT COALESCE(SUM(cr_t),0) FROM sect),
         (SELECT COUNT(*) FROM u),
         (SELECT COALESCE(SUM(abs(resid)),0) FROM u),
         (SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'net_debit_less_credit')::numeric DESC), '[]'::jsonb) FROM sched)
  INTO v_sections, v_dr, v_cr, v_unresolved_groups, v_unresolved_abs, v_unresolved;

  v_sections := COALESCE(v_sections, '{}'::jsonb);

  v_assets_current     := COALESCE(v_sections->'current_asset','[]'::jsonb);
  v_assets_non_current := COALESCE(v_sections->'non_current_asset','[]'::jsonb);
  v_liab_current       := COALESCE(v_sections->'current_liability','[]'::jsonb);
  v_liab_non_current   := COALESCE(v_sections->'non_current_liability','[]'::jsonb);
  v_equity             := COALESCE(v_sections->'equity','[]'::jsonb);

  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_revenue
  FROM jsonb_array_elements(COALESCE(v_sections->'revenue','[]'::jsonb)) e;
  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_expenses
  FROM jsonb_array_elements(COALESCE(v_sections->'expense','[]'::jsonb)) e;
  v_retained := v_revenue - v_expenses;

  v_equity := v_equity || jsonb_build_array(jsonb_build_object(
    'label','Retained Earnings / (Accumulated Deficit)',
    'value', v_retained,
    'source','general_ledger trial balance — revenue accounts less expense accounts'
  ));

  -- Excluded classifications are reported at group granularity: only groups whose
  -- every leg is excluded are actually left out of the statement.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'classification', classification, 'legs', legs, 'amount', amount) ORDER BY amount DESC), '[]'::jsonb)
  INTO v_excluded
  FROM (
    SELECT gl.classification, COUNT(*) legs, ROUND(SUM(gl.amount)) amount
    FROM general_ledger gl
    LEFT JOIN (
      SELECT transaction_group_id,
             bool_or(classification IN ('production','legacy_real')) AS has_reportable
      FROM general_ledger
      WHERE transaction_group_id IS NOT NULL
      GROUP BY transaction_group_id
    ) g ON g.transaction_group_id = gl.transaction_group_id
    WHERE gl.transaction_date <= p_as_at
      AND gl.classification NOT IN ('production','legacy_real')
      AND NOT COALESCE(g.has_reportable, false)
    GROUP BY gl.classification
  ) e;

  SELECT jsonb_build_array(
    jsonb_build_object('label','Rent plans outstanding (rent_requests)','value',
      (SELECT COALESCE(SUM(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0)),0)
         FROM rent_requests WHERE status IN ('funded','disbursed','repaying') AND created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Agent advances outstanding','value',
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0) + COALESCE(arrears_balance,0)),0)
         FROM agent_advances WHERE status IN ('active','overdue') AND created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Tenant business advances outstanding','value',
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0)),0)
         FROM business_advances WHERE status IN ('active','defaulted') AND created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Credit access draws outstanding','value',
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0)),0)
         FROM credit_access_draws WHERE status IN ('active','overdue') AND created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Merchandise sales outstanding','value',
      (SELECT COALESCE(SUM(COALESCE(amount_outstanding,0)),0)
         FROM merchandise_sales WHERE created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Promissory notes uncollected','value',
      (SELECT COALESCE(SUM(COALESCE(amount,0) - COALESCE(total_collected,0)),0)
         FROM promissory_notes WHERE status IN ('pending','activated') AND created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Partner portfolios per investor_portfolios (comparison)','value',
      (SELECT COALESCE(SUM(investment_amount),0) FROM investor_portfolios
        WHERE status = 'active' AND created_at <= p_as_at),
      'source','operational sub-ledger — compare against ledger account L2'),
    jsonb_build_object('label','Wallet cache: withdrawable + locked (comparison)','value',
      (SELECT COALESCE(SUM(withdrawable_balance + locked_balance),0) FROM wallets),
      'source','wallet cache — compare against ledger account L1'),
    jsonb_build_object('label','Wallet cache: float (comparison)','value',
      (SELECT COALESCE(SUM(float_balance),0) FROM wallets),
      'source','wallet cache — compare against ledger account A2'),
    jsonb_build_object('label','Landlord payouts pending (comparison)','value',
      (SELECT COALESCE(SUM(amount),0) FROM landlord_payouts
        WHERE status IN ('pending_merchant_payout','awaiting_agent_receipt') AND created_at <= p_as_at),
      'source','operational sub-ledger — compare against ledger account L4')
  ) INTO v_memo;

  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_tca FROM jsonb_array_elements(v_assets_current) e;
  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_tnca FROM jsonb_array_elements(v_assets_non_current) e;
  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_tcl FROM jsonb_array_elements(v_liab_current) e;
  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_tncl FROM jsonb_array_elements(v_liab_non_current) e;
  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_te FROM jsonb_array_elements(v_equity) e;

  v_ta := v_tca + v_tnca;
  v_tl := v_tcl + v_tncl;

  -- NO SUSPENSE PLUG. The residual is reported as a hard failure, never absorbed
  -- into Current Assets or Current Liabilities.
  v_residual := v_ta - (v_tl + v_te);
  v_balanced := abs(v_residual) < 1;

  RETURN jsonb_build_object(
    'as_at', p_as_at,
    'generated_at', now(),
    'currency', 'UGX',
    'assets', jsonb_build_object(
      'current', v_assets_current, 'non_current', v_assets_non_current,
      'total_current', v_tca, 'total_non_current', v_tnca, 'total', v_ta
    ),
    'liabilities', jsonb_build_object(
      'current', v_liab_current, 'non_current', v_liab_non_current,
      'total_current', v_tcl, 'total_non_current', v_tncl, 'total', v_tl
    ),
    'equity', jsonb_build_object(
      'lines', v_equity,
      'revenue_to_date', v_revenue,
      'expenses_to_date', v_expenses,
      'total', v_te
    ),
    'trial_balance', jsonb_build_object(
      'total_debits', ROUND(v_dr),
      'total_credits', ROUND(v_cr),
      'difference', ROUND(v_dr - v_cr),
      'balanced', abs(v_dr - v_cr) < 1
    ),
    'reconciliation', jsonb_build_object(
      'plug_applied', false,
      'suspense_amount', 0,
      'suspense_side', 'none',
      'unreconciled_difference', ROUND(v_residual),
      'unresolved_groups', v_unresolved_groups,
      'unresolved_absolute_amount', ROUND(v_unresolved_abs),
      'schedule', v_unresolved,
      'excluded_classifications', v_excluded,
      'memo_sub_ledgers', v_memo,
      'classification_filter_granularity', 'transaction_group'
    ),
    'balance_check', jsonb_build_object(
      'total_assets', v_ta,
      'total_liabilities_and_equity', v_tl + v_te,
      'difference', ROUND(v_residual),
      'balanced', v_balanced,
      'state', CASE WHEN v_balanced THEN 'balanced' ELSE 'failed' END,
      'message', CASE WHEN v_balanced
                      THEN 'Assets equal liabilities plus equity using real ledger data only.'
                      ELSE 'BALANCE CHECK FAILED: assets do not equal liabilities plus equity. No suspense plug has been applied — see the reconciliation schedule for the unbalanced transaction groups.'
                 END
    )
  );
END;
$function$;