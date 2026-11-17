-- Items 4 and 5 (CFO decisions 16 Nov 2026) — ACCOUNTING ONLY, no money movement, no change to any wallet, deposit,
-- portfolio or correction tool.
--   1. Balance-sheet resolver (sofp_ledger_legs and _window): a correction that changed a user's withdrawable or
--      locked balance (admin_correction wallet leg) is in the statements, going forward and for history (1,765 groups,
--      net -533.1M on wallets as at 16 Nov 2026). Its counterpart follows the existing resolver rules (balance
--      corrections: Legacy Opening Balance Adjustments E3).
--   2. Control C21 counts only the corrections still left out (float / unlabelled).
--   3. Reclassification categories used by batch acct_corr_202611_wallet_l1 (docs/finance/corrections/
--      2026-11-16_wallet_corrections_and_company_float.sql), run right after this, which also books item 5.
-- Preflight pins production's resolver, resolver window, fin_controls and category allowlist of 16 Nov 2026 (after items 1-2).
-- Rollback: supabase/rollbacks/20261125110000_wallet_corrections_in_statements.rollback.sql

DO $pre$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.sofp_ledger_legs(timestamp with time zone)'::regprocedure)) <> '9d705dc622f1bac5aa5eb842e54735b0'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.sofp_ledger_legs_window(timestamp with time zone,timestamp with time zone)'::regprocedure)) <> '6d075d2e1baea4fcedf26caa0cfb43d5'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.fin_controls(timestamp with time zone)'::regprocedure)) <> '08c79ce58d653e5ecd6d90d85c4e0d8e'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)) <> 'd5b3c0ccc662389f3f16af07c80e2da7' THEN
    RAISE EXCEPTION 'precondition failed: resolver, fin_controls or allowlist is no longer production''s definition of 16 Nov 2026; re-derive this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_account_map WHERE category LIKE 'wallet_correction_reclass_%') THEN
    RAISE EXCEPTION 'precondition failed: already installed';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.sofp_ledger_legs(p_as_at timestamp with time zone)
 RETURNS TABLE(transaction_group_id uuid, ledger_scope text, category text, source_table text, account_code text, dr numeric, cr numeric, group_one_sided boolean, is_legacy_counterpart boolean, transaction_date timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER COST 100000 ROWS 523000
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '120s'
 SET work_mem TO '64MB'
AS $function$
  WITH grp_class AS MATERIALIZED (
    SELECT gl.transaction_group_id,
           bool_or(gl.classification IN ('production','legacy_real')
                   OR (gl.classification = 'admin_correction'
                       AND gl.source_table = 'merchant_float_reconciliations')
                   -- 2026-11-16 (CFO): a correction that changed a user's withdrawable or locked balance changed what
                   -- Welile owes that user, so it is in the statements (items 4/5)
                   OR (gl.ledger_scope = 'wallet' AND gl.classification = 'admin_correction'
                       AND gl.wallet_bucket IN ('withdrawable', 'locked'))) AS has_reportable
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
        -- 2026-11-16 (CFO): Rent Plan funding books the rent owed to the landlord (L4, through the mapping row) until the
        -- landlord payout is sent; only a disbursement paid into a wallet in the same group (Welile Homes landlord rent
        -- paid through the agent's wallet) is still cash leaving (A1), as before.
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND s.n_wallet > 0 THEN 'A1'
        -- 2026-11-16 (CFO): the Landlord Float Pool is an earmark inside cash, not a separate cash line. Each pool
        -- movement is booked to the same cash account as its counterpart (A5 for principal returned from collections,
        -- A1 otherwise), so it nets to zero; the earmark is shown as a note on the balance sheet.
        WHEN b.sc = 'platform' AND b.cat IN ('landlord_pool_return_company_managed','landlord_pool_return_self_support') THEN 'A5'
        WHEN b.sc = 'platform' AND b.cat IN ('landlord_pool_reserve_company_managed','landlord_pool_reserve_self_support',
                                             'landlord_pool_topup_company_managed','landlord_pool_topup_self_support',
                                             'landlord_pool_compound_company_managed','landlord_pool_compound_self_support',
                                             'landlord_pool_deploy_company_managed','landlord_pool_deploy_self_support',
                                             'landlord_pool_release_company_managed','landlord_pool_release_self_support') THEN 'A1'
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
    -- 2026-11-16 (CFO): float used to record a collection closes the float cycle (A8), as a float settlement does;
    -- it does not pay the landlord (the landlord is paid by the landlord payout, DR L4 / CR A1).
    CROSS JOIN LATERAL (VALUES ('A5', a.amt), ('A8', a.amt)) AS v(acct, dr)
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

CREATE OR REPLACE FUNCTION public.sofp_ledger_legs_window(p_from timestamp with time zone, p_as_at timestamp with time zone)
 RETURNS TABLE(transaction_group_id uuid, ledger_scope text, category text, source_table text, account_code text, dr numeric, cr numeric, group_one_sided boolean, is_legacy_counterpart boolean, transaction_date timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER COST 100000 ROWS 523000
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '120s'
 SET work_mem TO '64MB'
AS $function$
  WITH win AS MATERIALIZED (
    SELECT DISTINCT w.transaction_group_id FROM general_ledger w
    WHERE w.transaction_date >= p_from AND w.transaction_date <= p_as_at AND w.transaction_group_id IS NOT NULL
  ), grp_class AS MATERIALIZED (
    SELECT gl.transaction_group_id,
           bool_or(gl.classification IN ('production','legacy_real')
                   OR (gl.classification = 'admin_correction'
                       AND gl.source_table = 'merchant_float_reconciliations')
                   -- 2026-11-16 (CFO): a correction that changed a user's withdrawable or locked balance changed what
                   -- Welile owes that user, so it is in the statements (items 4/5)
                   OR (gl.ledger_scope = 'wallet' AND gl.classification = 'admin_correction'
                       AND gl.wallet_bucket IN ('withdrawable', 'locked'))) AS has_reportable
    FROM general_ledger gl
    WHERE gl.transaction_group_id IN (SELECT transaction_group_id FROM win)
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
      AND (gl.transaction_group_id IN (SELECT transaction_group_id FROM win)
           OR (gl.transaction_group_id IS NULL AND gl.transaction_date >= p_from))
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
        -- 2026-11-16 (CFO): Rent Plan funding books the rent owed to the landlord (L4, through the mapping row) until the
        -- landlord payout is sent; only a disbursement paid into a wallet in the same group (Welile Homes landlord rent
        -- paid through the agent's wallet) is still cash leaving (A1), as before.
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND s.n_wallet > 0 THEN 'A1'
        -- 2026-11-16 (CFO): the Landlord Float Pool is an earmark inside cash, not a separate cash line. Each pool
        -- movement is booked to the same cash account as its counterpart (A5 for principal returned from collections,
        -- A1 otherwise), so it nets to zero; the earmark is shown as a note on the balance sheet.
        WHEN b.sc = 'platform' AND b.cat IN ('landlord_pool_return_company_managed','landlord_pool_return_self_support') THEN 'A5'
        WHEN b.sc = 'platform' AND b.cat IN ('landlord_pool_reserve_company_managed','landlord_pool_reserve_self_support',
                                             'landlord_pool_topup_company_managed','landlord_pool_topup_self_support',
                                             'landlord_pool_compound_company_managed','landlord_pool_compound_self_support',
                                             'landlord_pool_deploy_company_managed','landlord_pool_deploy_self_support',
                                             'landlord_pool_release_company_managed','landlord_pool_release_self_support') THEN 'A1'
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
    -- 2026-11-16 (CFO): float used to record a collection closes the float cycle (A8), as a float settlement does;
    -- it does not pay the landlord (the landlord is paid by the landlord payout, DR L4 / CR A1).
    CROSS JOIN LATERAL (VALUES ('A5', a.amt), ('A8', a.amt)) AS v(acct, dr)
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

CREATE OR REPLACE FUNCTION public.fin_controls(p_as_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_at   timestamptz := COALESCE(p_as_at, now());
  v_bs   jsonb;
  v_cf   jsonb;
  v_out  jsonb := '[]'::jsonb;
  v_n    bigint; v_amt numeric; v_detail jsonb;
  v_month_start timestamptz := date_trunc('month', v_at AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view accounting controls';
  END IF;

  -- C01 Balance Sheet equality
  v_bs := public.fin_balance_sheet(v_at);
  v_amt := COALESCE((v_bs->'balance_check'->>'difference')::numeric, 0);
  v_out := v_out || jsonb_build_object('id','C01','name','Assets = Liabilities + Equity',
    'status', CASE WHEN abs(v_amt) < 1 THEN 'ok' ELSE 'fail' END, 'value', ROUND(v_amt),
    'detail', 'Difference on the Balance Sheet. Unbalanced groups are listed in control C02.');

  -- C02 Groups unbalanced after mapping, logged by the posting control in the last 30 days
  SELECT COUNT(*), COALESCE(SUM(abs(residual)),0),
         COALESCE(jsonb_agg(jsonb_build_object('group', transaction_group_id, 'residual', ROUND(residual), 'source', source_table, 'at', detected_at) ORDER BY detected_at DESC) FILTER (WHERE rn <= 10), '[]'::jsonb)
    INTO v_n, v_amt, v_detail
  FROM (SELECT v.*, row_number() OVER (ORDER BY detected_at DESC) rn FROM public.ledger_mapped_balance_violations v
        WHERE detected_at > v_at - interval '30 days') z;
  v_out := v_out || jsonb_build_object('id','C02','name','Entries unbalanced after account mapping (last 30 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt), 'detail', v_detail);

  -- C03 Suspense balances (A9 debit suspense and L9 credit suspense)
  v_amt := COALESCE((SELECT SUM(abs((e->>'value')::numeric)) FROM jsonb_array_elements(
             COALESCE(v_bs->'assets'->'current','[]'::jsonb) || COALESCE(v_bs->'liabilities'->'current','[]'::jsonb)) e
           WHERE e->>'source' LIKE '%account A9' OR e->>'source' LIKE '%account L9'), 0);
  v_out := v_out || jsonb_build_object('id','C03','name','Suspense (unmapped postings) balance',
    'status', CASE WHEN abs(v_amt) < 1 THEN 'ok' ELSE 'warn' END, 'value', ROUND(v_amt));

  -- C05 Cash Flow explained in full (current month)
  v_cf := public.fin_cash_flow(v_month_start, v_at);
  v_amt := COALESCE((v_cf->>'unexplained_difference')::numeric, 0);
  v_out := v_out || jsonb_build_object('id','C05','name','Cash Flow fully explained this month (no balancing line)',
    'status', CASE WHEN abs(v_amt) < 1 THEN 'ok' ELSE 'fail' END, 'value', ROUND(v_amt),
    'detail', v_cf->'unexplained_groups');

  -- C06 Mobile-money balances reported by provider SMS (freshness)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('channel', channel, 'balance', balance, 'at', at,
                     'hours_old', ROUND(EXTRACT(EPOCH FROM (v_at - at)) / 3600, 1))), '[]'::jsonb),
         COUNT(*) FILTER (WHERE at < v_at - interval '24 hours')
    INTO v_detail, v_n
  FROM (SELECT DISTINCT ON (channel) channel, balance, COALESCE(internal_date, created_at) at
        FROM public.gmail_transactions
        WHERE channel IN ('mtn_momo','airtel_money') AND balance IS NOT NULL AND from_email ILIKE '%ifttt%'
        ORDER BY channel, COALESCE(internal_date, created_at) DESC) z;
  v_out := v_out || jsonb_build_object('id','C06','name','Mobile-money line balances (provider SMS)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'detail', v_detail);

  -- C08 Deposits marked "banked" without a matching Equity credit email (same amount, ±3 days)
  WITH latest AS (
    SELECT DISTINCT ON (v.deposit_request_id) v.deposit_request_id, v.amount, v.status, COALESCE(v.verified_at, v.created_at) at
    FROM public.cash_deposit_verifications v ORDER BY v.deposit_request_id, v.created_at DESC
  ), banked AS (
    SELECT l.* FROM latest l JOIN public.deposit_requests dr ON dr.id = l.deposit_request_id
    WHERE l.status = 'verified' AND COALESCE(dr.purpose_audit->>'cash_location','cash_at_hand') = 'bank'
  ), unmatched AS (
    SELECT b.* FROM banked b
    WHERE NOT EXISTS (SELECT 1 FROM public.gmail_transactions g
                      WHERE g.from_email ILIKE '%equitybank%' AND g.direction = 'in' AND g.amount = b.amount
                        AND COALESCE(g.internal_date, g.created_at) BETWEEN b.at - interval '3 days' AND b.at + interval '3 days')
  )
  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_n, v_amt FROM unmatched;
  v_out := v_out || jsonb_build_object('id','C08','name','Deposits marked banked with no matching Equity credit',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt),
    'detail', 'Bulk banking (several deposits in one credit) also appears here; review against bank statements.');

  -- C09 / C10 / C11 sub-ledger ties from the Balance Sheet
  SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) INTO v_detail FROM jsonb_array_elements(v_bs->'subledger_ties') e;
  v_out := v_out || jsonb_build_object('id','C09','name','Ledger vs operational records (wallets, portfolios, Rent Plans, advances, notes)',
    'status', CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_bs->'subledger_ties') e WHERE abs((e->>'difference')::numeric) >= 1)
                   THEN 'warn' ELSE 'ok' END,
    'value', (SELECT COUNT(*) FROM jsonb_array_elements(v_bs->'subledger_ties') e WHERE abs((e->>'difference')::numeric) >= 1),
    'detail', v_detail);

  -- C11 Rent Plans marked completed while still owing, measured by collections actually received
  --     (a stored balance can be typed to zero, so it cannot be the test; review 9 Nov 2026)
  WITH col AS (
    SELECT rent_request_id rr, SUM(amount) collected
    FROM public.agent_collections WHERE reversed_at IS NULL AND rent_request_id IS NOT NULL GROUP BY 1
  )
  SELECT COUNT(*), COALESCE(SUM(COALESCE(r.total_repayment,0) - COALESCE(col.collected,0)),0) INTO v_n, v_amt
  FROM public.rent_requests r LEFT JOIN col ON col.rr = r.id
  WHERE r.status = 'completed' AND COALESCE(r.total_repayment,0) - COALESCE(col.collected,0) > 0.5;
  v_out := v_out || jsonb_build_object('id','C11','name','Rent Plans completed while still owing (by collections actually received)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt),
    'detail', 'Includes plans registered with older balances and plans cleared by staff edits; review against the Tenant Repayment Tracker.');

  -- C14 Back-dated postings (transaction date more than 2 days before posting) in the last 30 days
  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_n, v_amt
  FROM public.general_ledger
  WHERE created_at > v_at - interval '30 days' AND transaction_date < created_at - interval '2 days'
    AND classification IN ('production','legacy_real','admin_correction');
  v_out := v_out || jsonb_build_object('id','C14','name','Back-dated postings (last 30 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt));

  -- C15 Completed withdrawals with no ledger entry
  SELECT COUNT(*), COALESCE(SUM(w.amount),0) INTO v_n, v_amt
  FROM public.withdrawal_requests w
  WHERE w.status IN ('completed','paid')
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.source_table = 'withdrawal_requests' AND g.source_id = w.id);
  v_out := v_out || jsonb_build_object('id','C15','name','Paid withdrawals with no ledger entry',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt));

  -- C16 Abnormal merchandise recovery plans
  SELECT COUNT(*), COALESCE(SUM(outstanding_balance),0),
         COALESCE(jsonb_agg(jsonb_build_object('plan', id, 'item', item_name, 'outstanding', ROUND(outstanding_balance), 'daily', ROUND(daily_deduction_amount), 'status', status)), '[]'::jsonb)
    INTO v_n, v_amt, v_detail
  FROM public.merchandise_recovery_plans
  WHERE status = 'active' AND (COALESCE(original_amount,0) > 50000000 OR COALESCE(daily_deduction_amount,0) > 2000000);
  v_out := v_out || jsonb_build_object('id','C16','name','Abnormal merchandise recovery plans (> 50M or > 2M a day)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt), 'detail', v_detail);

  -- C19 Landlord payouts still open on Rent Plans whose funding was reversed (allocation returned)
  WITH rev AS (
    SELECT g.source_id rr FROM public.general_ledger g
    WHERE g.source_table = 'rent_requests' AND g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
    GROUP BY 1 HAVING SUM(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END) <= 0.5
                  AND bool_or(g.direction = 'cash_in')
  )
  SELECT COUNT(*), COALESCE(SUM(p.amount),0),
         COALESCE(jsonb_agg(jsonb_build_object('payout', p.id, 'rent_request', p.rent_request_id, 'amount', p.amount, 'status', p.status, 'created', p.created_at)), '[]'::jsonb)
    INTO v_n, v_amt, v_detail
  FROM public.landlord_payouts p JOIN rev ON rev.rr = p.rent_request_id
  WHERE p.status IN ('pending','otp_verified','pending_merchant_payout');
  v_out := v_out || jsonb_build_object('id','C19','name','Landlord payouts still open after the allocation was returned',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt), 'detail', v_detail);

  -- C20 Rent Plans funded in the ledger with no successful landlord payout after 7 days
  WITH led AS (
    SELECT g.source_id rr, SUM(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END) net, MIN(g.transaction_date) first_d
    FROM public.general_ledger g
    WHERE g.source_table = 'rent_requests' AND g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production','legacy_real')
    GROUP BY 1
  )
  SELECT COUNT(*), COALESCE(SUM(led.net),0) INTO v_n, v_amt
  FROM led
  WHERE led.net > 0.5 AND led.first_d < v_at - interval '7 days' AND led.first_d >= timestamptz '2026-06-01 00:00+03'
    AND NOT EXISTS (SELECT 1 FROM public.landlord_payouts p WHERE p.rent_request_id = led.rr
                    AND p.status IN ('completed','awaiting_agent_receipt','pending_merchant_payout'));
  v_out := v_out || jsonb_build_object('id','C20','name','Rent Plans funded in the ledger with no landlord payout (since June, older than 7 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt));

  -- C21 Admin-correction wallet legs (move wallets, excluded from statements) in the last 30 days
  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_n, v_amt
  FROM public.general_ledger gl
  WHERE gl.ledger_scope = 'wallet' AND gl.classification = 'admin_correction' AND gl.created_at > v_at - interval '30 days'
    -- 2026-11-16: corrections to withdrawable or locked balances are now in the statements; only the others are left out
    AND COALESCE(gl.wallet_bucket, '') NOT IN ('withdrawable', 'locked')
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger g2 WHERE g2.transaction_group_id = gl.transaction_group_id
                    AND g2.classification IN ('production','legacy_real'));
  v_out := v_out || jsonb_build_object('id','C21','name','Wallet corrections left out of the statements (last 30 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt));

  RETURN jsonb_build_object('as_at', v_at, 'generated_at', now(), 'controls', v_out,
    'summary', jsonb_build_object(
      'fail', (SELECT COUNT(*) FROM jsonb_array_elements(v_out) e WHERE e->>'status' = 'fail'),
      'warn', (SELECT COUNT(*) FROM jsonb_array_elements(v_out) e WHERE e->>'status' = 'warn'),
      'ok',   (SELECT COUNT(*) FROM jsonb_array_elements(v_out) e WHERE e->>'status' = 'ok')));
END;
$function$;

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT ((((public.ledger_category_allowlist_base() || ARRAY[

    'staff_loan_charge_collected',

    'agent_advance_receivable_opening',

    'agent_access_fee_receivable_opening',

    'merchandise_recovery_receivable_opening',

    'bike_recovery_receivable_opening',

    'credit_draw_receivable_opening',

    'merchandise_credit_sale_receivable_opening',

    'service_centre_advance_receivable_opening',

    'service_centre_receivable_opening',

    'tenant_service_charge_receivable_opening',

    'business_advance_receivable_opening',

    'rent_plan_receivable_restatement',

    'receivable_restatement_equity',

    'merchandise_recovery_repayment',

    'bike_recovery_repayment',

    'credit_draw_repayment',

    'smartphone_advance_receivable',

    'agent_advance_disbursement',

    'agent_advance_access_fee_charged',

    'agent_advance_registration_fee_charged',

    'agent_advance_fee_revenue',

    'agent_advance_penalty_accrued',

    'agent_advance_penalty_unearned',

    'agent_advance_access_fee_collected',

    'agent_advance_registration_fee_collected',

    'agent_advance_written_off',

    'agent_advance_access_fee_written_off',

    'agent_advance_registration_fee_written_off',

    'agent_advance_reversed',

    'agent_advance_clawback',

    'agent_advance_late_fee_income',

    'agent_advance_access_fee_collected_external',

    'agent_advance_registration_fee_collected_external',

    'agent_advance_penalty_accrued_external',

    -- Landlord Float Pool (20260929160000, 20260929180000, 20260929240000)

    'landlord_pool_reserve_self_support',

    'landlord_pool_reserve_company_managed',

    'landlord_pool_reserve_source',

    'landlord_pool_topup_self_support',

    'landlord_pool_topup_company_managed',

    'landlord_pool_compound_self_support',

    'landlord_pool_compound_company_managed',

    'landlord_pool_deploy_self_support',

    'landlord_pool_deploy_company_managed',

    'landlord_pool_deploy_target',

    'landlord_pool_return_self_support',

    'landlord_pool_return_company_managed',

    'landlord_pool_return_source',

    'landlord_pool_release_self_support',

    'landlord_pool_release_company_managed',

    'landlord_pool_release_target'

  ]::text[]) || ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',

                       'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']::text[]) || ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',

                       'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income']::text[]

    -- 2026-11-04 (CFO, merchandise phase 3): merchandise sales revenue (R1); offset of the advance shown on an agent's

    -- wallet for a phone bought by the company (L1 memo, not money owed to the agent)

    || ARRAY['merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained']::text[]

    || ARRAY['agent_advance_memo_offset']::text[]

    -- 2026-11-10 (CFO draft): platform-only reversal of a float restatement loss booked in error (X6)

    || ARRAY['float_restatement_correction']::text[]) || ARRAY['welile_cover_fee']::text[]

    -- 2026-11-11 (CFO): salary advances to employees (A27 Loans and Advances to Employees)

    || ARRAY['salary_advance_disbursed', 'salary_advance_cash_paid', 'salary_advance_recovered', 'salary_advance_recovery_expense']::text[]
    -- 2026-11-12 (CFO): Welile Homes landlord float paid to landlords settles the landlord payout obligation (L4)
    || ARRAY['wh_landlord_float_settled']::text[]
    -- 2026-11-12 (CFO): Special Advance repaid from the borrower's wallet (wallet L1 / platform A24)
    || ARRAY['special_advance_wallet_repayment']::text[]
    -- 2026-11-12 (Joshua, CTO): mobile-money and bank-transfer advance repayments
    || ARRAY['agent_advance_receipt_bank', 'agent_advance_repayment_external']::text[]) || ARRAY['partner_direct_rent_capital']::text[]
    -- 2026-11-16 (CFO): landlord rent payout sent — settles the rent owed to the landlord (L4) and is the cash leaving (A1)
    || ARRAY['landlord_rent_payout_settled', 'landlord_rent_payout_cash']::text[]
    -- 2026-11-16 (CFO): reclassification of a wallet correction to the account of the credit it reversed
    || ARRAY['wallet_correction_reclass_e3', 'wallet_correction_reclass_x1', 'wallet_correction_reclass_x2', 'wallet_correction_reclass_x3', 'wallet_correction_reclass_x4', 'wallet_correction_reclass_a1', 'wallet_correction_reclass_a2', 'wallet_correction_reclass_a8', 'wallet_correction_reclass_a10', 'wallet_correction_reclass_l6']::text[];
$function$;


-- Reclassification categories (platform only): a wallet correction now in the statements is first set against
-- Legacy Opening Balance Adjustments (E3, the resolver's rule for balance corrections); where it reversed an earlier
-- credit, it is moved to that credit's account. cash_in = debit, cash_out = credit.
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes) VALUES
  ('platform', 'wallet_correction_reclass_e3', NULL, 'E3', 'cash_in', '2026-11-16 (CFO): wallet correction reclassified to E3.'),
  ('platform', 'wallet_correction_reclass_x1', NULL, 'X1', 'cash_in', '2026-11-16 (CFO): wallet correction reclassified to X1.'),
  ('platform', 'wallet_correction_reclass_x2', NULL, 'X2', 'cash_in', '2026-11-16 (CFO): wallet correction reclassified to X2.'),
  ('platform', 'wallet_correction_reclass_x3', NULL, 'X3', 'cash_in', '2026-11-16 (CFO): wallet correction reclassified to X3.'),
  ('platform', 'wallet_correction_reclass_x4', NULL, 'X4', 'cash_in', '2026-11-16 (CFO): wallet correction reclassified to X4.'),
  ('platform', 'wallet_correction_reclass_a1', NULL, 'A1', 'cash_in', '2026-11-16 (CFO): wallet correction reclassified to A1.'),
  ('platform', 'wallet_correction_reclass_a2', NULL, 'A2', 'cash_in', '2026-11-16 (CFO): wallet correction reclassified to A2.'),
  ('platform', 'wallet_correction_reclass_a8', NULL, 'A8', 'cash_in', '2026-11-16 (CFO): wallet correction reclassified to A8.'),
  ('platform', 'wallet_correction_reclass_a10', NULL, 'A10', 'cash_in', '2026-11-16 (CFO): wallet correction reclassified to A10.'),
  ('platform', 'wallet_correction_reclass_l6', NULL, 'L6', 'cash_in', '2026-11-16 (CFO): wallet correction reclassified to L6.');
