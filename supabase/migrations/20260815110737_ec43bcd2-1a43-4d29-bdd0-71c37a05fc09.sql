-- ============================================================================
-- Balance Sheet performance fix (accounting results unchanged)
--
-- Root cause of "canceling statement due to statement timeout":
--   sofp_ledger_legs() resolved each ledger leg's account via a correlated
--   LATERAL (... ORDER BY ... LIMIT 1) over ledger_account_map. The planner
--   turned that into a Nested Loop executing a Seq Scan + Sort of
--   ledger_account_map ONCE PER LEDGER ROW -> 396,284 loops, ~4.6s per call.
--   get_statement_of_financial_position() called that set-returning function
--   FOUR times (trial balance, unresolved-group count, unresolved-group sum,
--   unresolved schedule), i.e. ~1.6M map lookups and ~19s of ledger work
--   before the memo sub-ledger queries even started.
--
-- Fix (no change to mapping semantics or arithmetic):
--   1. Resolve the map with two plain equi-joins (bucket-specific, then
--      wildcard) instead of a per-row LATERAL. ledger_account_map_key
--      (ledger_scope, category, COALESCE(wallet_bucket,'*')) is UNIQUE, so
--      each join matches at most one row -- exactly what LIMIT 1 with
--      "bucket-specific first" produced. Verified account-by-account:
--      all 15 accounts return identical dr/cr to the previous version.
--   2. Compute the shared legs ONCE per report in a single materialised CTE
--      and derive the trial balance, group residuals and suspense schedule
--      from it, instead of re-scanning the ledger four times.
--   3. Add (classification, transaction_date) index so an as-at date in the
--      past reads only the relevant slice of the ledger.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_gl_classification_txdate
  ON public.general_ledger (classification, transaction_date);

-- Same output columns and semantics; hash-joinable map resolution.
CREATE OR REPLACE FUNCTION public.sofp_ledger_legs(p_as_at timestamp with time zone)
RETURNS TABLE(transaction_group_id uuid, ledger_scope text, category text, account_code text, dr numeric, cr numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH resolved AS (
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
      AND gl.transaction_date <= p_as_at
  )
  SELECT r.transaction_group_id, r.ledger_scope, r.category, r.account_code,
         CASE WHEN r.direction = r.debit_when THEN r.amount ELSE 0 END,
         CASE WHEN r.direction = r.debit_when THEN 0 ELSE r.amount END
  FROM resolved r;
$function$;

-- Single-pass version. Accounting logic, signs, thresholds, labels, sources,
-- suspense treatment and memo disclosures are byte-for-byte the same.
CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position(p_as_at timestamp with time zone DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the statement of financial position';
  END IF;

  -- ONE ledger pass feeds the trial balance, the group residual totals and the
  -- reconciliation schedule. `legs` is referenced three times so Postgres
  -- materialises it once instead of re-scanning general_ledger per consumer.
  WITH legs AS MATERIALIZED (
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
      AND gl.transaction_date <= p_as_at
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

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'classification', classification, 'legs', legs, 'amount', amount) ORDER BY amount DESC), '[]'::jsonb)
  INTO v_excluded
  FROM (
    SELECT classification, COUNT(*) legs, ROUND(SUM(amount)) amount
    FROM general_ledger
    WHERE classification NOT IN ('production','legacy_real')
      AND transaction_date <= p_as_at
    GROUP BY classification
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

  v_residual := (v_tca + v_tnca) - (v_tcl + v_tncl + v_te);

  IF v_residual > 0.5 THEN
    v_liab_current := v_liab_current || jsonb_build_array(jsonb_build_object(
      'label','Suspense — one-sided ledger postings awaiting their counterpart',
      'value', v_residual,
      'source','general_ledger groups whose debits and credits do not agree (see reconciliation schedule)'));
    v_tcl := v_tcl + v_residual;
  ELSIF v_residual < -0.5 THEN
    v_assets_current := v_assets_current || jsonb_build_array(jsonb_build_object(
      'label','Suspense — one-sided ledger postings awaiting their counterpart',
      'value', -v_residual,
      'source','general_ledger groups whose debits and credits do not agree (see reconciliation schedule)'));
    v_tca := v_tca - v_residual;
  END IF;

  v_ta := v_tca + v_tnca;
  v_tl := v_tcl + v_tncl;

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
      'suspense_amount', ROUND(abs(v_residual)),
      'suspense_side', CASE WHEN v_residual > 0.5 THEN 'liability' WHEN v_residual < -0.5 THEN 'asset' ELSE 'none' END,
      'unresolved_groups', v_unresolved_groups,
      'unresolved_absolute_amount', ROUND(v_unresolved_abs),
      'schedule', v_unresolved,
      'excluded_classifications', v_excluded,
      'memo_sub_ledgers', v_memo
    ),
    'balance_check', jsonb_build_object(
      'total_assets', v_ta,
      'total_liabilities_and_equity', v_tl + v_te,
      'difference', v_ta - (v_tl + v_te),
      'balanced', abs(v_ta - (v_tl + v_te)) < 1
    )
  );
END;
$function$;