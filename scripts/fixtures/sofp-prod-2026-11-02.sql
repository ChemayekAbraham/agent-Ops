-- Verbatim production copies (2026-11-02, read-only export via pg_get_functiondef, project byrzshwlentqvktcksem) of the
-- balance-sheet resolver and the statement of financial position, for the Special Advances Phase D tests
-- (src/test/specialAdvanceSofpMemo.test.ts) and the resolver checks of Phases B and C.
--   sofp_ledger_legs(timestamptz)                    md5(prosrc) 843ccf477014f8c7a8e0b5c6f14a1ba0
--   get_statement_of_financial_position(timestamptz) md5(prosrc) 2ee44b04b0dd9f383116d3d218881c53
--     config ["search_path=public", "statement_timeout=120s"]
-- Phase D's preflight refuses unless the live statement function still has exactly this fingerprint.

CREATE OR REPLACE FUNCTION public.sofp_ledger_legs(p_as_at timestamp with time zone)
 RETURNS TABLE(transaction_group_id uuid, ledger_scope text, category text, source_table text, account_code text, dr numeric, cr numeric, group_one_sided boolean, is_legacy_counterpart boolean, transaction_date timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER COST 100000 ROWS 523000
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '120s'
 SET work_mem TO '256MB'
AS $function$
  WITH grp_class AS MATERIALIZED (
    SELECT gl.transaction_group_id,
           bool_or(gl.classification IN ('production','legacy_real')
                   OR (gl.classification = 'admin_correction'
                       AND gl.source_table = 'merchant_float_reconciliations')) AS has_reportable
    FROM general_ledger gl
    WHERE gl.transaction_group_id IS NOT NULL
    GROUP BY gl.transaction_group_id
  ), bike_plans AS MATERIALIZED (
    SELECT p.id FROM merchandise_recovery_plans p
    WHERE public.agent_product_category(p.item_name) = 'motor_bike'
  ), base AS MATERIALIZED (
    SELECT gl.id,
           gl.transaction_group_id AS real_gid,
           COALESCE(gl.transaction_group_id, gl.id) AS gid,
           gl.transaction_date AS tdate,
           gl.ledger_scope AS sc,
           gl.category AS cat,
           gl.source_table AS src,
           gl.direction AS dir,
           gl.amount AS amt,
           (bp.id IS NOT NULL) AS is_bike,
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
    LEFT JOIN bike_plans bp ON gl.source_table = 'merchandise_recovery_plans' AND bp.id = gl.source_id
    LEFT JOIN ledger_account_map mb ON mb.ledger_scope = gl.ledger_scope AND mb.category = gl.category
          AND mb.wallet_bucket IS NOT NULL AND mb.wallet_bucket = gl.wallet_bucket
    LEFT JOIN ledger_account_map mw ON mw.ledger_scope = gl.ledger_scope AND mw.category = gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.transaction_date <= p_as_at
      AND CASE WHEN gl.transaction_group_id IS NULL THEN gl.classification IN ('production','legacy_real')
               ELSE COALESCE(g.has_reportable, false) END
  ), shape AS MATERIALIZED (
    SELECT b.gid,
           count(*) AS n_legs,
           count(*) FILTER (WHERE b.sc = 'wallet') AS n_wallet,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'A2') AS n_a2,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'L1') AS n_l1,
           count(*) FILTER (WHERE b.sc = 'platform') AS n_plat,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'system_balance_correction') AS n_plat_sbc,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment')) AS n_repay,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.acct0 = 'R1') AS n_rev,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'landlord_receivable_collected') AS n_land_recv,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'cash_custody_payable') AS n_custody,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'wallet_deposit' AND b.dir = 'cash_out') AS n_bank_receipt,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'A2' AND b.cat = 'agent_float_used_for_rent' AND b.dir = 'cash_out') AS n_a2_float_out,
           sum(CASE WHEN b.dir = 'cash_in' THEN b.amt ELSE -b.amt END) AS raw_net,
           max(b.tdate) AS max_tdate
    FROM base b GROUP BY b.gid
  ), adj AS MATERIALIZED (
    SELECT b.real_gid, b.gid, b.tdate, b.sc, b.cat, b.src, b.dir, b.amt, s.raw_net, s.n_a2_float_out,
      s.n_wallet, s.n_a2, s.n_l1, s.n_plat, s.n_plat_sbc,
      CASE
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 AND b.src = 'merchant_float_reconciliations' THEN 'A8'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'X6'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' THEN 'E3'
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset' AND b.src = 'agent_collections' AND b.dir = 'cash_out' THEN 'A3'
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_requests' THEN 'A10'
        -- 2026-10-01 (CFO approved): advance top-ups are money owed by the agent, not cash leaving the bank.
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_topups' THEN 'A10'
        -- 2026-10-01 (CFO approved): ANG2609259307 share owned by Pius, paid from company float -> receivable from Pius.
        WHEN b.sc = 'wallet' AND b.cat = 'share_capital' AND b.acct0 = 'A2' AND b.real_gid = '121a7430-bb4a-458c-9859-51b8c16c63b5'::uuid THEN 'A23'
        WHEN b.sc = 'platform' AND b.cat = 'agent_repayment' AND b.src = 'agent_advances' THEN 'A10'
        WHEN b.sc = 'wallet'   AND b.cat = 'advance_repayment' AND b.src = 'agent_advances' THEN 'A10'
        WHEN b.sc = 'platform' AND b.cat = 'agent_repayment' AND b.src = 'credit_access_draws' THEN 'A14'
        WHEN b.sc = 'platform' AND b.cat = 'agent_repayment' AND b.src = 'merchandise_sales' THEN 'A15'
        WHEN b.sc = 'platform' AND b.cat = 'agent_repayment' AND b.src = 'merchandise_recovery_plans' AND b.is_bike THEN 'A13'
        WHEN b.sc = 'platform' AND b.cat = 'agent_repayment' AND b.src = 'merchandise_recovery_plans' THEN 'A12'
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_a2 > 0 AND s.n_l1 = 0 THEN 'A1'
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_l1 > 0 THEN 'E3'
        WHEN b.sc = 'platform' AND b.cat = 'wallet_withdrawal' AND s.n_wallet > 0 AND s.n_l1 = 0 THEN 'L1'
        -- NARROWED (2026-09-23): the shape-keyed A8 override no longer captures the three
        -- bucket-movement categories. Their withdrawable side is customer custody payable (L1)
        -- and the balancing cost is recognised in X4 below.
        WHEN b.sc = 'wallet' AND b.acct0 = 'L1' AND b.cat NOT IN ('bucket_reclass_in','bucket_reclass_out','wallet_transfer')
             AND s.n_wallet = 2 AND s.n_a2 = 1 AND s.n_l1 = 1 AND (s.n_plat = 0 OR s.n_plat = s.n_plat_sbc) THEN 'A8'
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset' AND s.n_custody > 0 AND s.n_wallet > 0 AND s.n_a2 = 0 THEN 'L1'
        ELSE b.acct0
      END AS acct,
      CASE
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND b.cat = 'agent_float_used_for_rent' THEN b.dw0
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset' AND b.src = 'agent_collections' AND b.dir = 'cash_out' THEN 'cash_in'
        WHEN b.sc = 'platform' AND b.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment') AND s.n_a2_float_out > 0
             THEN CASE WHEN b.dir = 'cash_in' THEN 'cash_out' ELSE 'cash_in' END
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'cash_in'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_requests' THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_topups' THEN 'cash_out'
        WHEN b.sc = 'wallet' AND b.cat = 'share_capital' AND b.acct0 = 'A2' AND b.real_gid = '121a7430-bb4a-458c-9859-51b8c16c63b5'::uuid THEN b.dir
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_a2 > 0 AND s.n_l1 = 0 THEN 'cash_in'
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_l1 > 0 THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'wallet_withdrawal' AND s.n_wallet > 0 AND s.n_l1 = 0 THEN b.dir
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset' AND s.n_custody > 0 AND s.n_wallet > 0 AND s.n_a2 = 0 THEN b.dir
        WHEN b.sc = 'platform' AND b.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment','landlord_receivable_collected') AND s.n_a2 > 0
             THEN CASE WHEN b.dir = 'cash_in' THEN 'cash_out' ELSE 'cash_in' END
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND (s.n_repay > 0 OR s.n_land_recv > 0) THEN b.dir
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND s.n_bank_receipt > 0 THEN CASE WHEN b.dir = 'cash_in' THEN 'cash_out' ELSE 'cash_in' END
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND s.n_rev > 0 THEN b.dir
        WHEN b.sc = 'wallet' AND b.acct0 = 'L1' AND b.cat NOT IN ('bucket_reclass_in','bucket_reclass_out','wallet_transfer')
             AND s.n_wallet = 2 AND s.n_a2 = 1 AND s.n_l1 = 1 AND (s.n_plat = 0 OR s.n_plat = s.n_plat_sbc) THEN 'cash_in'
        ELSE b.dw0
      END AS dw
    FROM base b JOIN shape s ON s.gid = b.gid
  ), mapped0 AS MATERIALIZED (
    SELECT a.real_gid, a.gid, a.tdate, a.sc, a.cat, a.src, a.acct, a.raw_net,
           CASE WHEN a.dir = a.dw THEN a.amt ELSE 0 END AS dr,
           CASE WHEN a.dir = a.dw THEN 0 ELSE a.amt END AS cr
    FROM adj a
  ), synth AS MATERIALIZED (
    SELECT a.real_gid, a.gid, a.tdate, 'reconciliation'::text AS sc,
           'float_backed_collection_counterpart'::text AS cat, a.src, v.acct, a.raw_net,
           v.dr::numeric AS dr, 0::numeric AS cr
    FROM adj a
    CROSS JOIN LATERAL (VALUES ('A5', a.amt), ('L4', a.amt)) AS v(acct, dr)
    WHERE a.sc = 'platform'
      AND a.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment')
      AND a.n_a2_float_out > 0
  ), synth_reclass AS MATERIALIZED (
    -- BUCKET RECLASS COUNTERPART (2026-09-23): a float <-> withdrawable movement derecognises
    -- company float AND creates/settles a customer custody claim. Both sides are real, so the
    -- balancing cost (or recovery) is recognised in X4, category-keyed so nothing else is caught.
    SELECT a.real_gid, a.gid, a.tdate, 'reconciliation'::text AS sc,
           v.cat, a.src, 'X4'::text AS acct, a.raw_net,
           CASE WHEN a.dir = 'cash_in'  THEN a.amt ELSE 0 END::numeric AS dr,
           CASE WHEN a.dir = 'cash_out' THEN a.amt ELSE 0 END::numeric AS cr
    FROM adj a
    CROSS JOIN LATERAL (VALUES ('float_derecognised_on_bucket_reclass'::text),
                               ('custody_recognised_on_bucket_reclass'::text)) AS v(cat)
    WHERE a.sc = 'wallet'
      AND a.acct = 'L1'
      -- 2026-10-01 (CFO approved): bucket_reclass_in/out pairs are balanced internal moves; no synthetic X4 cost.
      AND a.cat = 'wallet_transfer'
      AND a.n_wallet = 2 AND a.n_a2 = 1 AND a.n_l1 = 1
      AND (a.n_plat = 0 OR a.n_plat = a.n_plat_sbc)
  ), mapped AS MATERIALIZED (
    SELECT * FROM mapped0
    UNION ALL SELECT * FROM synth
    UNION ALL SELECT * FROM synth_reclass
  ), one_sided AS (
    SELECT m.gid, SUM(m.dr) - SUM(m.cr) AS resid, MAX(m.tdate) AS tdate
    FROM mapped m GROUP BY m.gid
    HAVING abs(MAX(m.raw_net)) > 0.5 AND abs(SUM(m.dr) - SUM(m.cr)) > 0.5
  )
  SELECT m.real_gid, m.sc, m.cat, m.src, m.acct, m.dr, m.cr,
         (o.gid IS NOT NULL) AS group_one_sided, false AS is_legacy_counterpart, m.tdate
  FROM mapped m LEFT JOIN one_sided o ON o.gid = m.gid
  UNION ALL
  SELECT NULL::uuid, 'reconciliation', 'legacy_one_sided_counterpart', NULL, 'E4',
         CASE WHEN o.resid < 0 THEN -o.resid ELSE 0 END,
         CASE WHEN o.resid > 0 THEN  o.resid ELSE 0 END,
         true, true, o.tdate
  FROM one_sided o;
$function$
;

CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position(p_as_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
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
$function$
;
