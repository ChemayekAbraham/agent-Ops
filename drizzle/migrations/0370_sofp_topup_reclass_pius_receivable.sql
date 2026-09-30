INSERT INTO public.ledger_account_catalog(code,label,section,nature,sort_order) VALUES ('A23','Receivable from Pius — Angel Pool share','current_asset','asset',123) ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.sofp_ledger_legs(p_as_at timestamp with time zone)
 RETURNS TABLE(transaction_group_id uuid, ledger_scope text, category text, source_table text, account_code text, dr numeric, cr numeric, group_one_sided boolean, is_legacy_counterpart boolean, transaction_date timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER COST 100000 ROWS 523000
 SET search_path TO 'public'
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
$function$;