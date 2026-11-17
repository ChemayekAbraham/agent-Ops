-- Item 2 (CFO decision 16 Nov 2026, "earmark only"): the Landlord Float Pool is an earmark within cash.
-- PRESENTATION OF THE ACCOUNTS ONLY: no ledger posting, no money movement, no change to how the pool reserves, deploys,
-- releases or returns money (landlord_pool_* functions, tables and screens unchanged).
--   1. Balance-sheet resolver (sofp_ledger_legs and _window): pool movements are booked to the same cash account as their
--      counterpart (A1, or A5 for principal returned from collections), so A21/A22 no longer appear as cash lines and
--      Cash and Bank (A1) is no longer drained by the set-aside. Total cash is unchanged. History re-states automatically.
--   2. fin_balance_sheet: memo line "Landlord Float Pool — cash earmarked for landlords" and updated disclosures
--      (pool, and L4 after item 1).
-- The Treasury card and the CFO weekly report read the base account mapping and keep showing cash available with the
-- pool separately (unchanged).
-- Preflight pins production's resolver, resolver window and fin_balance_sheet of 16 Nov 2026 (after item 1).
-- Rollback: supabase/rollbacks/20261125100000_landlord_pool_earmark.rollback.sql

DO $pre$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.sofp_ledger_legs(timestamp with time zone)'::regprocedure)) <> '05abf47889ef136b2ba88ad8b72270f1'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.sofp_ledger_legs_window(timestamp with time zone,timestamp with time zone)'::regprocedure)) <> '253a1cdbbb511bba125d08f526107f4e'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.fin_balance_sheet(timestamp with time zone)'::regprocedure)) <> '4a15e6686e12ffb8c034b89b936e9af9' THEN
    RAISE EXCEPTION 'precondition failed: resolver or fin_balance_sheet is no longer production''s definition of 16 Nov 2026 (after item 1); re-derive this migration';
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
                       AND gl.source_table = 'merchant_float_reconciliations')) AS has_reportable
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

CREATE OR REPLACE FUNCTION public.fin_balance_sheet(p_as_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_sofp jsonb;
  v_val  jsonb;
  v_ties jsonb;
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view the balance sheet';
  END IF;

  v_sofp := public.get_statement_of_financial_position(COALESCE(p_as_at, now()));

  -- account values by code, from the statement just produced
  SELECT jsonb_object_agg(substring(e->>'source' from 'account ([A-Z0-9]+)$'), (e->>'value')::numeric)
    INTO v_val
  FROM (
    SELECT jsonb_array_elements(COALESCE(v_sofp->'assets'->'current','[]'::jsonb) || COALESCE(v_sofp->'assets'->'non_current','[]'::jsonb)
                              || COALESCE(v_sofp->'liabilities'->'current','[]'::jsonb) || COALESCE(v_sofp->'liabilities'->'non_current','[]'::jsonb)) e
  ) z
  WHERE substring(e->>'source' from 'account ([A-Z0-9]+)$') IS NOT NULL;

  WITH w AS (
    SELECT COALESCE(SUM(withdrawable_balance),0) wd, COALESCE(SUM(locked_balance),0) lk,
           COALESCE(SUM(float_balance),0) fl, COALESCE(SUM(advance_balance),0) adv FROM public.wallets
  ), t AS (
    SELECT
      (SELECT COALESCE(SUM(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0)),0) FROM public.rent_requests
        WHERE status IN ('funded','disbursed','repaying') AND created_at <= COALESCE(p_as_at, now())) AS rent_book,
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0)),0) FROM public.agent_advances
        WHERE status IN ('active','overdue') AND created_at <= COALESCE(p_as_at, now())) AS advances,
      (SELECT COALESCE(SUM(investment_amount),0) FROM public.investor_portfolios
        WHERE status = 'active' AND created_at <= COALESCE(p_as_at, now())) AS portfolios,
      (SELECT COALESCE(SUM(v.outstanding),0) FROM public.v_partner_note_settlement v JOIN public.promissory_notes n ON n.id = v.note_id
        WHERE n.status = 'activated' AND n.created_at <= COALESCE(p_as_at, now())) AS notes
  )
  SELECT jsonb_build_array(
    jsonb_build_object('key','rent_plans','label','Rent Plan receivables (A3) vs Rent Plan book',
      'ledger', ROUND(COALESCE((v_val->>'A3')::numeric,0)), 'operational', ROUND(t.rent_book),
      'difference', ROUND(COALESCE((v_val->>'A3')::numeric,0) - t.rent_book)),
    jsonb_build_object('key','agent_advances','label','Agent advances (A10+A11+A20) vs open advances outstanding (fees and arrears included)',
      'basis','outstanding_only_v2',
      'ledger', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0)),
      'operational', ROUND(t.advances),
      'difference', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0) - t.advances)),
    jsonb_build_object('key','supporter_capital','label','Supporter capital (L2 less unpaid promissory notes A7) vs active portfolios',
      'ledger', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.portfolios),
      'difference', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0) - t.portfolios)),
    jsonb_build_object('key','promissory_notes','label','Promissory notes (A7) vs activated notes not yet settled',
      'ledger', ROUND(COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.notes),
      'difference', ROUND(COALESCE((v_val->>'A7')::numeric,0) - t.notes)),
    jsonb_build_object('key','wallet_custody','label','Wallet custody (L1) vs wallets withdrawable + locked',
      'ledger', ROUND(COALESCE((v_val->>'L1')::numeric,0)), 'operational', ROUND(w.wd + w.lk),
      'difference', ROUND(COALESCE((v_val->>'L1')::numeric,0) - (w.wd + w.lk))),
    jsonb_build_object('key','agent_float','label','Agent float (A2) vs wallets float',
      'ledger', ROUND(COALESCE((v_val->>'A2')::numeric,0)), 'operational', ROUND(w.fl),
      'difference', ROUND(COALESCE((v_val->>'A2')::numeric,0) - w.fl))
  ) INTO v_ties
  FROM w, t;

  -- Comparison lines corrected (CFO, 10 Nov 2026): merchandise counts issued orders only (receivable recognised
  -- when an order is issued, policy of 4 Nov 2026); promissory notes split into activated and not yet activated.
  WITH memo AS (
    SELECT e FROM jsonb_array_elements(COALESCE(v_sofp->'reconciliation'->'memo_sub_ledgers', '[]'::jsonb)) e
    WHERE e->>'label' NOT IN ('Merchandise sales outstanding', 'Promissory notes uncollected')
  ), extra AS (
    SELECT jsonb_build_array(
      jsonb_build_object('label', 'Merchandise sales outstanding — issued orders only',
        'value', (SELECT COALESCE(SUM(COALESCE(amount_outstanding,0)),0) FROM public.merchandise_sales
                  WHERE order_status IN ('issued','completed') AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — orders marked issued or completed (receivable recognised on issue)'),
      jsonb_build_object('label', 'Merchandise orders not yet issued (not a receivable)',
        'value', (SELECT COALESCE(SUM(COALESCE(amount_outstanding,0)),0) FROM public.merchandise_sales
                  WHERE COALESCE(order_status,'') NOT IN ('issued','completed','rejected','failed','cancelled')
                    AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — pending, approved or awaiting handover; information only'),
      jsonb_build_object('label', 'Promissory notes activated, not yet settled',
        'value', (SELECT COALESCE(SUM(v.outstanding),0) FROM public.v_partner_note_settlement v JOIN public.promissory_notes n ON n.id = v.note_id
                  WHERE n.status = 'activated' AND n.created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — note amount less collections, fund-ins attributed to the note and CFO-confirmed funding; compare against ledger account A7'),
      jsonb_build_object('label', 'Landlord Float Pool — cash earmarked for landlords (included in cash above)',
        'value', (SELECT COALESCE(SUM(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END), 0)
                    FROM public.general_ledger g
                   WHERE g.ledger_scope = 'platform' AND g.category IN ('landlord_pool_reserve_company_managed','landlord_pool_reserve_self_support','landlord_pool_topup_company_managed','landlord_pool_topup_self_support','landlord_pool_compound_company_managed','landlord_pool_compound_self_support','landlord_pool_deploy_company_managed','landlord_pool_deploy_self_support','landlord_pool_release_company_managed','landlord_pool_release_self_support','landlord_pool_return_company_managed','landlord_pool_return_self_support')
                     AND g.classification IN ('production', 'legacy_real') AND g.transaction_date <= COALESCE(p_as_at, now())),
        'source', 'ledger pool movements (reserve, top-up, compounding and returned principal, less amounts deployed or released); an earmark within Cash and Bank and Cash in Transit, not a separate balance'),
      jsonb_build_object('label', 'Promissory notes not yet activated (commitments only)',
        'value', (SELECT COALESCE(SUM(COALESCE(amount,0) - COALESCE(total_collected,0)),0) FROM public.promissory_notes
                  WHERE status = 'pending' AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — not recognised in the ledger')
    ) j
  )
  SELECT jsonb_set(v_sofp, '{reconciliation,memo_sub_ledgers}',
                   COALESCE((SELECT jsonb_agg(e) FROM memo), '[]'::jsonb) || (SELECT j FROM extra))
    INTO v_sofp
  WHERE v_sofp ? 'reconciliation';

  RETURN v_sofp || jsonb_build_object(
    'engine', 'fin_balance_sheet',
    'subledger_ties', v_ties,
    'subledger_ties_basis', 'Ledger balances are as at the statement date; operational figures (wallets, Rent Plan balances, advances, portfolios, notes) are as they stand now, so ties for past dates are indicative only.',
    'disclosures', jsonb_build_array(
      'Partner Product Receivables (A7) are activated promissory notes not yet settled by Supporter capital; the same amount is included in Supporter capital (L2). A note settled by a funded portfolio is released, so the capital is counted once.',
      'Landlord Float Pool is company cash earmarked to fund Rent Plans (Supporter capital and compounded Returns). Since 16 Nov 2026 it is shown as a note within cash (memo line), not as separate cash lines, and it is not money owed to landlords.',
      'Cash and Bank (A1) is negative mainly because verified cash deposits remain in Cash in Transit (A5); the two should be read together.',
      'Landlord Rent Payable (L4) is rent owed to landlords for funded Rent Plans until the landlord payout is sent (since 16 Nov 2026), plus Welile Homes landlord obligations.')
  );
END;
$function$;
