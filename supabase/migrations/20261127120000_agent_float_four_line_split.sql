-- Agent float split into four lines (CFO decision 17 Nov 2026: agent float = what agents hold in float wallets).
--
-- Accounting only. No money moves; no wallet, deposit, collection or portfolio record changes; no posting.
-- Agent float (A2, Cash at Hand - Float with Agents) showed about UGX 1,265M while agents' float wallets held 58.8M.
-- The difference moves to four named asset lines; total assets and equity are unchanged.
--   A28 Partner top-ups paid from agent float - to be confirmed with agents: each Partner top-up paid from an agent's
--       float now takes the float out of A2 into A28 (two reconciliation legs, same group); Partner cash recorded as
--       received through an agent (agent_float_cash_offset, which credited A2) now credits A28. A28 = top-ups paid from
--       float not yet matched by a Partner cash receipt (about 530.5M on 17 Nov).
--   A29 Tenant collections recorded against agent float (22 Sep 2026 restatement) - to be traced: the 10,794
--       agent_float_cash_offset legs of 21-22 Sep 2026 (274.7M).
--   A31 Agent-facilitated capital receivable: agent_facilitated_capital_receivable (56.7M), a receivable, not float.
--   A30 Agent float to be reconciled: the rest (344.7M: April-July float entries without a bucket label, admin
--       corrections, merchant reconciliations, CFO credits, other) is moved by the dated batch
--       docs/finance/corrections/2026-11-17_agent_float_to_reconcile.sql (categories added here).
-- A28, A29 and A31 apply to history and to every future entry through the resolver. A30 is history only; any new
-- difference shows in the daily tie-out "Agent float (A2) vs wallets float".
-- get_treasury_cash_position and the CFO weekly report use base mapping and are unaffected.
-- Preflight pins production's resolver, resolver window and category allowlist of 17 Nov 2026.
-- Rollback: supabase/rollbacks/20261127120000_agent_float_four_line_split.rollback.sql
DO $pre$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.sofp_ledger_legs(timestamp with time zone)'::regprocedure)) <> 'ecb8b23e0ca8ade5e8bbf8e038fc93b3'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.sofp_ledger_legs_window(timestamp with time zone,timestamp with time zone)'::regprocedure)) <> 'b9cc5024e7aad384bd2c5b2be9607cdf'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)) <> 'c9551dca56139130f3b2e0a60761c815' THEN
    RAISE EXCEPTION 'precondition failed: resolver or allowlist is no longer production''s definition of 17 Nov 2026; re-derive this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_account_catalog WHERE code IN ('A28','A29','A30','A31')) THEN
    RAISE EXCEPTION 'precondition failed: accounts A28-A31 already exist';
  END IF;
END $pre$;

INSERT INTO public.ledger_account_catalog (code, label, section, nature, sort_order) VALUES
  ('A28', 'Partner top-ups paid from agent float — to be confirmed with agents', 'current_asset', 'asset', 21),
  ('A29', 'Tenant collections recorded against agent float (22 Sep 2026 restatement) — to be traced', 'current_asset', 'asset', 22),
  ('A30', 'Agent float to be reconciled', 'current_asset', 'asset', 23),
  ('A31', 'Agent-facilitated capital receivable', 'current_asset', 'asset', 24);

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes) VALUES
  ('platform', 'agent_float_to_reconcile',         NULL, 'A30', 'cash_in', 'Agent float history moved to Agent float to be reconciled (CFO 17 Nov 2026)'),
  ('platform', 'agent_float_to_reconcile_from_a2', NULL, 'A2',  'cash_in', 'Agent float history moved out of agent float (posted cash_out = credit A2)');

INSERT INTO public.fin_cash_flow_map (account_code, category, section, group_label, group_sort, line_in, line_out, sort) VALUES
  ('A28', NULL, 'operating', 'Agent float (company-owned)', 30, 'Partner top-ups from agent float confirmed', 'Partner top-ups paid from agent float', 20),
  ('A29', NULL, 'operating', 'Agent float (company-owned)', 30, 'Restated tenant collections traced', 'Restated tenant collections recorded', 21),
  ('A30', NULL, 'operating', 'Agent float (company-owned)', 30, 'Agent float reconciled', 'Agent float to be reconciled', 22),
  ('A31', NULL, 'operating', 'Agent float (company-owned)', 30, 'Agent-facilitated capital collected', 'Agent-facilitated capital advanced', 23)
ON CONFLICT (account_code, category) DO NOTHING;

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
    || ARRAY['wallet_correction_reclass_e3', 'wallet_correction_reclass_x1', 'wallet_correction_reclass_x2', 'wallet_correction_reclass_x3', 'wallet_correction_reclass_x4', 'wallet_correction_reclass_a1', 'wallet_correction_reclass_a2', 'wallet_correction_reclass_a8', 'wallet_correction_reclass_a10', 'wallet_correction_reclass_l6']::text[]
    -- 2026-11-16 (CFO, item 7): fees of Rent Plans funded before the fee entries began (8 Sep 2026)
    || ARRAY['legacy_plan_fee_restated_e3', 'legacy_plan_fee_deferred', 'legacy_plan_fee_revenue']::text[]
    -- 2026-11-17 (CFO): agent float history moved to 'Agent float to be reconciled' (A30)
    || ARRAY['agent_float_to_reconcile', 'agent_float_to_reconcile_from_a2']::text[];
$function$;

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
           gl.wallet_bucket AS bkt,
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
    SELECT b.real_gid, b.gid, b.tdate, b.sc, b.cat, b.src, b.dir, b.amt, b.bkt, s.raw_net, s.n_a2_float_out,
      s.n_wallet, s.n_a2, s.n_l1, s.n_plat, s.n_plat_sbc,
      CASE
        -- 2026-11-16 (CFO, items 4/5 follow-up): balancing legs of a wallet route repair and of a platform orphan
        -- reversal are corrections against Legacy Opening Balance Adjustments (credit E3)
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND b.src = 'wallet_route_repair' THEN 'E3'
        WHEN b.sc = 'platform' AND b.cat = 'orphan_reversal' THEN 'E3'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 AND b.src = 'merchant_float_reconciliations' THEN 'A8'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'X6'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' THEN 'E3'
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset' AND b.src = 'agent_collections' AND b.dir = 'cash_out' THEN 'A3'
        -- 2026-11-17 (CFO): agent float (A2) is what agents hold in their float wallets. Tenant collections recorded
        -- against agent float by the 22 Sep 2026 restatement are shown on their own line (A29, to be traced), and the
        -- agent-facilitated capital receivable is a receivable (A31), not float.
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset' AND b.src = 'agent_collections' AND b.dir = 'cash_in'
             AND b.acct0 = 'A2' AND NOT (s.n_custody > 0 AND s.n_wallet > 0 AND s.n_a2 = 0) THEN 'A29'
        WHEN b.sc = 'platform' AND b.cat = 'agent_facilitated_capital_receivable' AND b.acct0 = 'A2' THEN 'A31'
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
        -- 2026-11-17 (CFO): Partner cash recorded as received through an agent settles the Partner top-ups that agents
        -- paid from float (A28), instead of reducing agent float.
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset' AND b.acct0 = 'A2' THEN 'A28'
        ELSE b.acct0
      END AS acct,
      CASE
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND b.src = 'wallet_route_repair' THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'orphan_reversal' THEN 'cash_out'
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
  ), synth_float_topup AS MATERIALIZED (
    -- 2026-11-17 (CFO): a Partner top-up paid from an agent's float takes the float out of agent float (A2) into
    -- 'Partner top-ups paid from agent float - to be confirmed with agents' (A28). The top-up's own legs are unchanged.
    SELECT a.real_gid, a.gid, a.tdate, 'reconciliation'::text AS sc, v.cat, a.src, v.acct, a.raw_net,
           CASE WHEN (a.dir = 'cash_out') = v.is_dr THEN a.amt ELSE 0 END::numeric AS dr,
           CASE WHEN (a.dir = 'cash_out') = v.is_dr THEN 0 ELSE a.amt END::numeric AS cr
    FROM adj a
    CROSS JOIN LATERAL (VALUES ('partner_topup_from_agent_float'::text, 'A28'::text, true),
                               ('agent_float_spent_on_partner_topup'::text, 'A2'::text, false)) AS v(cat, acct, is_dr)
    WHERE a.sc = 'wallet' AND a.cat = 'partner_funding' AND a.bkt = 'float' AND a.acct = 'L1'
  ), mapped AS MATERIALIZED (
    SELECT * FROM mapped0
    UNION ALL SELECT * FROM synth
    UNION ALL SELECT * FROM synth_reclass
    UNION ALL SELECT * FROM synth_float_topup
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
           gl.wallet_bucket AS bkt,
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
    SELECT b.real_gid, b.gid, b.tdate, b.sc, b.cat, b.src, b.dir, b.amt, b.bkt, s.raw_net, s.n_a2_float_out,
      s.n_wallet, s.n_a2, s.n_l1, s.n_plat, s.n_plat_sbc,
      CASE
        -- 2026-11-16 (CFO, items 4/5 follow-up): balancing legs of a wallet route repair and of a platform orphan
        -- reversal are corrections against Legacy Opening Balance Adjustments (credit E3)
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND b.src = 'wallet_route_repair' THEN 'E3'
        WHEN b.sc = 'platform' AND b.cat = 'orphan_reversal' THEN 'E3'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 AND b.src = 'merchant_float_reconciliations' THEN 'A8'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'X6'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' THEN 'E3'
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset' AND b.src = 'agent_collections' AND b.dir = 'cash_out' THEN 'A3'
        -- 2026-11-17 (CFO): agent float (A2) is what agents hold in their float wallets. Tenant collections recorded
        -- against agent float by the 22 Sep 2026 restatement are shown on their own line (A29, to be traced), and the
        -- agent-facilitated capital receivable is a receivable (A31), not float.
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset' AND b.src = 'agent_collections' AND b.dir = 'cash_in'
             AND b.acct0 = 'A2' AND NOT (s.n_custody > 0 AND s.n_wallet > 0 AND s.n_a2 = 0) THEN 'A29'
        WHEN b.sc = 'platform' AND b.cat = 'agent_facilitated_capital_receivable' AND b.acct0 = 'A2' THEN 'A31'
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
        -- 2026-11-17 (CFO): Partner cash recorded as received through an agent settles the Partner top-ups that agents
        -- paid from float (A28), instead of reducing agent float.
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset' AND b.acct0 = 'A2' THEN 'A28'
        ELSE b.acct0
      END AS acct,
      CASE
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND b.src = 'wallet_route_repair' THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'orphan_reversal' THEN 'cash_out'
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
  ), synth_float_topup AS MATERIALIZED (
    -- 2026-11-17 (CFO): a Partner top-up paid from an agent's float takes the float out of agent float (A2) into
    -- 'Partner top-ups paid from agent float - to be confirmed with agents' (A28). The top-up's own legs are unchanged.
    SELECT a.real_gid, a.gid, a.tdate, 'reconciliation'::text AS sc, v.cat, a.src, v.acct, a.raw_net,
           CASE WHEN (a.dir = 'cash_out') = v.is_dr THEN a.amt ELSE 0 END::numeric AS dr,
           CASE WHEN (a.dir = 'cash_out') = v.is_dr THEN 0 ELSE a.amt END::numeric AS cr
    FROM adj a
    CROSS JOIN LATERAL (VALUES ('partner_topup_from_agent_float'::text, 'A28'::text, true),
                               ('agent_float_spent_on_partner_topup'::text, 'A2'::text, false)) AS v(cat, acct, is_dr)
    WHERE a.sc = 'wallet' AND a.cat = 'partner_funding' AND a.bkt = 'float' AND a.acct = 'L1'
  ), mapped AS MATERIALIZED (
    SELECT * FROM mapped0
    UNION ALL SELECT * FROM synth
    UNION ALL SELECT * FROM synth_reclass
    UNION ALL SELECT * FROM synth_float_topup
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
