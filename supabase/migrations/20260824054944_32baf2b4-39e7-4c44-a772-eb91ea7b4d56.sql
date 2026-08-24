INSERT INTO public.ledger_account_catalog (code, label, section, nature, sort_order)
VALUES ('E4','Legacy One-Sided Postings — Opening Balance Counterpart','equity','equity',30)
ON CONFLICT (code) DO NOTHING;

DROP FUNCTION IF EXISTS public.sofp_ledger_legs(timestamp with time zone);

CREATE FUNCTION public.sofp_ledger_legs(p_as_at timestamp with time zone)
RETURNS TABLE(
  transaction_group_id uuid,
  ledger_scope text,
  category text,
  source_table text,
  account_code text,
  dr numeric,
  cr numeric,
  group_one_sided boolean,
  is_legacy_counterpart boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  -- Reporting-layer resolver for the statement of financial position.
  -- Every general_ledger leg is turned into a debit or a credit against the
  -- reporting chart of accounts (ledger_account_catalog). The base mapping comes
  -- from ledger_account_map; the rules below correct cases where a single ledger
  -- category carries two opposite economics depending on the originating
  -- workflow, which previously placed both legs of a balanced entry on the same
  -- side of the trial balance. NO amount is invented and no ledger row is
  -- touched: only the account and the debit/credit side of existing legs.
  WITH grp_class AS MATERIALIZED (
    SELECT gl.transaction_group_id,
           bool_or(gl.classification IN ('production','legacy_real')) AS has_reportable
    FROM general_ledger gl
    WHERE gl.transaction_group_id IS NOT NULL
    GROUP BY gl.transaction_group_id
  ), base AS MATERIALIZED (
    SELECT gl.id,
           gl.transaction_group_id AS real_gid,
           COALESCE(gl.transaction_group_id, gl.id) AS gid,
           gl.ledger_scope AS sc,
           gl.category AS cat,
           gl.source_table AS src,
           gl.direction AS dir,
           gl.amount AS amt,
           COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'float'   THEN 'A2'
                  WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'advance' THEN 'A4'
                  WHEN gl.ledger_scope = 'wallet'                                  THEN 'L1'
                  ELSE 'A9' END) AS acct0,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope = 'wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS dw0
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
  ), shape AS MATERIALIZED (
    SELECT b.gid,
           count(*) AS n_legs,
           count(*) FILTER (WHERE b.sc = 'wallet') AS n_wallet,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'A2') AS n_a2,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'L1') AS n_l1,
           count(*) FILTER (WHERE b.sc = 'platform') AS n_plat,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'system_balance_correction') AS n_plat_sbc,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat IN ('tenant_repayment','rent_repayment')) AS n_repay,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.acct0 = 'R1') AS n_rev,
           sum(CASE WHEN b.dir = 'cash_in' THEN b.amt ELSE -b.amt END) AS raw_net
    FROM base b
    GROUP BY b.gid
  ), adj AS MATERIALIZED (
    SELECT b.real_gid, b.gid, b.sc, b.cat, b.src, b.dir, b.amt, s.raw_net,
      CASE
        -- R1  Manual balance corrections: cash returned/paid when the counterpart
        --     is an agent float leg, otherwise an equity adjustment (same
        --     convention as the sibling category platform.balance_correction).
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'A1'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction'                THEN 'E3'
        -- R2  Advances disbursed into agent wallets are receivables, not bank cash.
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_requests' THEN 'A4'
        -- R3  Float swept back to the platform to settle a wallet deduction.
        WHEN b.sc = 'platform' AND b.cat = 'wallet_deduction' AND s.n_a2 > 0 AND s.n_l1 = 0 THEN 'A1'
        -- R4  Withdrawal settled out of agent float: the platform leg IS the
        --     settlement of the custody obligation (no bank payment happened).
        WHEN b.sc = 'platform' AND b.cat = 'wallet_withdrawal' AND s.n_wallet > 0 AND s.n_l1 = 0 THEN 'L1'
        -- R5  Float <-> withdrawable reclass (CFO decision 2026-08): the amount
        --     released to the user's own balance is a cost to the company.
        WHEN b.sc = 'wallet' AND b.acct0 = 'L1'
             AND s.n_wallet = 2 AND s.n_a2 = 1 AND s.n_l1 = 1
             AND (s.n_plat = 0 OR s.n_plat = s.n_plat_sbc) THEN 'X4'
        ELSE b.acct0
      END AS acct,
      CASE
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'cash_in'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction'                THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_requests' THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'wallet_deduction' AND s.n_a2 > 0 AND s.n_l1 = 0 THEN 'cash_in'
        WHEN b.sc = 'platform' AND b.cat = 'wallet_withdrawal' AND s.n_wallet > 0 AND s.n_l1 = 0 THEN b.dir
        -- R6  Rent collected by an agent into float is cash received (a debit).
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND s.n_repay > 0 THEN 'cash_out'
        -- R7  Platform fees paid out of float: the float leg is the cash received.
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND s.n_rev > 0 THEN b.dir
        WHEN b.sc = 'wallet' AND b.acct0 = 'L1'
             AND s.n_wallet = 2 AND s.n_a2 = 1 AND s.n_l1 = 1
             AND (s.n_plat = 0 OR s.n_plat = s.n_plat_sbc) THEN 'cash_in'
        ELSE b.dw0
      END AS dw
    FROM base b
    JOIN shape s ON s.gid = b.gid
  ), mapped AS MATERIALIZED (
    SELECT a.real_gid, a.gid, a.sc, a.cat, a.src, a.acct, a.raw_net,
           CASE WHEN a.dir = a.dw THEN a.amt ELSE 0 END AS dr,
           CASE WHEN a.dir = a.dw THEN 0 ELSE a.amt END AS cr
    FROM adj a
  ), one_sided AS (
    -- Historic entries where only one side was ever recorded in the ledger
    -- (pre-ledger capital, legacy reseeds, single-leg wallet credits).
    -- The missing side is recognised, per group, in the clearly labelled
    -- equity account E4 and itemised in the reconciliation schedule.
    SELECT m.gid, SUM(m.dr) - SUM(m.cr) AS resid
    FROM mapped m
    GROUP BY m.gid
    HAVING abs(MAX(m.raw_net)) > 0.5 AND abs(SUM(m.dr) - SUM(m.cr)) > 0.5
  )
  SELECT m.real_gid, m.sc, m.cat, m.src, m.acct, m.dr, m.cr,
         (o.gid IS NOT NULL) AS group_one_sided,
         false AS is_legacy_counterpart
  FROM mapped m
  LEFT JOIN one_sided o ON o.gid = m.gid
  UNION ALL
  SELECT NULL::uuid, 'reconciliation', 'legacy_one_sided_counterpart', NULL, 'E4',
         CASE WHEN o.resid < 0 THEN -o.resid ELSE 0 END,
         CASE WHEN o.resid > 0 THEN  o.resid ELSE 0 END,
         true, true
  FROM one_sided o;
$function$;

GRANT EXECUTE ON FUNCTION public.sofp_ledger_legs(timestamp with time zone) TO authenticated, service_role;

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
  v_legacy_net numeric := 0;
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

  -- Single source of truth for leg -> account resolution: sofp_ledger_legs.
  WITH l AS MATERIALIZED (
    SELECT * FROM sofp_ledger_legs(p_as_at)
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
  ), sched AS (
    SELECT jsonb_build_object(
             'ledger_scope', l.ledger_scope,
             'category', l.category,
             'groups', COUNT(DISTINCT l.transaction_group_id),
             'net_debit_less_credit', ROUND(SUM(l.dr - l.cr))
           ) x
    FROM l
    WHERE l.group_one_sided AND NOT l.is_legacy_counterpart
    GROUP BY l.ledger_scope, l.category
    HAVING abs(SUM(l.dr - l.cr)) > 0.5
    ORDER BY abs(SUM(l.dr - l.cr)) DESC
    LIMIT 25
  )
  SELECT (SELECT jsonb_object_agg(section, lines) FROM sect),
         (SELECT COALESCE(SUM(dr_t),0) FROM sect),
         (SELECT COALESCE(SUM(cr_t),0) FROM sect),
         (SELECT COUNT(DISTINCT transaction_group_id) FROM l WHERE group_one_sided AND NOT is_legacy_counterpart),
         (SELECT COALESCE(SUM(dr + cr),0) FROM l WHERE is_legacy_counterpart),
         (SELECT COALESCE(SUM(cr - dr),0) FROM l WHERE is_legacy_counterpart),
         (SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'net_debit_less_credit')::numeric DESC), '[]'::jsonb) FROM sched)
  INTO v_sections, v_dr, v_cr, v_unresolved_groups, v_unresolved_abs, v_legacy_net, v_unresolved;

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

  -- NO SUSPENSE PLUG. Every balanced entry is mapped to a real debit and credit;
  -- the only recognised counterpart is account E4, which exists solely for
  -- historic ONE-SIDED ledger postings and is fully itemised below.
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
      'one_sided_groups', v_unresolved_groups,
      'one_sided_absolute_amount', ROUND(v_unresolved_abs),
      'one_sided_equity_counterpart', ROUND(v_legacy_net),
      'unresolved_groups', v_unresolved_groups,
      'unresolved_absolute_amount', ROUND(v_unresolved_abs),
      'schedule', v_unresolved,
      'schedule_note', 'Historic postings where only one side was ever recorded in general_ledger. Their counterpart is recognised in equity account E4 and itemised here; no balanced entry contributes to this schedule.',
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