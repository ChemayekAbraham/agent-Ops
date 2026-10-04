-- Landlord/Rent: recognise Registration and Access fees ACTUALLY COLLECTED from
-- each daily tenant payment as GROSS Platform Treasury fee revenue in R1.
--
-- THE REQUIREMENT
-- Per daily tenant payment the CFO needs: total collected, principal component,
-- registration fee collected, access fee collected, and the resulting Platform
-- Treasury fee revenue - traceable back to the individual payment.
--
-- WHY IT DID NOT EXIST
--   * instalment_allocations had 0 rows after 222 collections (UGX 6,183,977):
--     the Agent Collection route calls no allocation logic at all.
--   * fee_revenue_ledger recognises on ELAPSED TIME
--     (pct = (now() - funded_at)/duration_days). It never reads amount_repaid
--     and never posts to the ledger, so it answers "fees earned by the
--     calendar", not "fees collected". 167m asserted there vs R1 net 10.4m.
--     Left intact for historical/non-cash reporting; NOT authoritative for
--     collected fees.
--   * treasury_net_revenue netted agent commission against revenue, so R1 could
--     never state gross fee revenue by fee type.
--
-- APPROVED ACCOUNTING. For a 10,000 payment allocated 7,160 / 477 / 2,363:
--
--   GROUP A  cash and receivable          (existing route - NOT touched here)
--     DR A2/A1                  10,000
--     CR A3  tenant_repayment   10,000
--
--   GROUP B  fees actually collected      (THIS MIGRATION)
--     DR L7  treasury_fee_drawdown       2,840
--     CR R1  registration_fee_collected    477
--     CR R1  access_fee_collected        2,363
--
--   GROUP C  agent commission            (existing route - NOT touched here)
--     DR X3 / CR L1                      1,000   expense, never netted vs R1
--
-- WHY treasury_fee_drawdown HAD TO BE ADDED - proven, not preferred.
-- The approved entry is IMPOSSIBLE with the pre-existing mappings:
--     L7 treasury_allocated        debit_when=cash_in  -> DR needs cash_in
--     L7 treasury_fee_recognised   debit_when=cash_in  -> DR needs cash_in
--     R1 registration_fee_collected debit_when=cash_out -> CR needs cash_in
--     R1 access_fee_collected       debit_when=cash_out -> CR needs cash_in
-- Every leg would be cash_in, so create_ledger_transaction's raw-direction
-- control can never balance. First attempt failed exactly there:
--     "Transaction not balanced. Total cash_in (5680) <> total cash_out (0)"
-- There is no third L7 category. One new category mapped to the EXISTING L7
-- account with the opposite convention resolves it:
--     (platform, treasury_fee_drawdown, NULL) -> L7, debit_when='cash_out'
-- so a cash_out leg DEBITS L7. Raw: cash_out(fees) = cash_in(reg+access).
-- Mapped: DR L7 = CR R1. Both controls pass.
-- No new ACCOUNT is created, and the debit_when of the two R1 fee categories is
-- deliberately NOT altered - changing it would have reversed the meaning of the
-- 8 existing cfo_direct_credit access-fee legs (+2,601,500), restating history.
--
-- THE R1 FEE CATEGORIES ARE SHARED WITH OTHER BUSINESS LINES.
-- A forensic check found they already carry 2,621,500 of net R1 credit that is
-- NOT rent: cfo_direct_credit access fees (+2,601,500) and an agent-advance
-- registration-fee batch posted then reversed (+20,000 residue). Six live edge
-- functions can add more (auto-charge-wallets, cfo-direct-credit,
-- cfo-record-advance-payment, process-agent-advance-deductions, product-purchase,
-- voluntary-repay-advance).
--
-- THEREFORE NOTHING HERE EVER FILTERS ON CATEGORY ALONE. Every rent figure is
-- anchored on instalment_allocations.transaction_group_id, which only
-- post_rent_fee_collection writes. reconcile_rent_fee_l7() reports the excluded
-- non-rent total explicitly so the separation stays visible.
--
-- MISSING FUNDING RECOGNITION never blocks a tenant payment. L7 may only be
-- drawn down against a funding-side credit that exists; if it does not, the
-- payment proceeds and an auditable exception is written instead of inventing an
-- L7 balance.
--
-- A2 IS DELIBERATELY UNTOUCHED. The Agent Collection cash-shape defect
-- (A2/CR + A3/CR, 166 groups, -10,970,520) is a separate agent-float model
-- question under investigation. Group B balances independently, so this adds no
-- new A2 posting and does not compound the defect.

-- 1. New category: allowlist + mapping ----------------------------------
CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $function$
  SELECT '{"🔧 Manual Adjustment",access_fee_collected,account_merge,advance_repayment,agent_advance_credit,agent_advance_repayment,agent_bonus,agent_commission,agent_commission_accrued,agent_commission_earned,agent_commission_payable,agent_commission_settled,agent_commission_used_for_rent,agent_commission_withdrawal,agent_facilitated_capital_receivable,agent_float_assignment,agent_float_cash_offset,agent_float_deposit,agent_float_funding,agent_float_settlement,agent_float_topup,agent_float_used,agent_float_used_for_rent,agent_investment_commission,agent_landlord_payout,agent_proxy_investment,agent_repayment,angel_pool_investment,balance_correction,bucket_reclass_in,bucket_reclass_out,cash_at_bank_reclass,cash_custody_payable,cash_in_transit_banked,cash_receipt_in_transit,cfo_direct_credit,coo_proxy_investment,coo_proxy_investment_reversal,correction_reversal,credit_access_repayment,debt_clearance,debt_recovery,deposit,equipment_expense,fee_receivable_created,general_admin_expense,historical_balance_reseed,interest_expense,landlord_receivable_collected,landlord_receivable_created,landlord_receivable_obligation,landlord_rent_payment,listing_bonus,listing_bonus_expense,listing_rejection_offset,listing_rejection_penalty,listing_rejection_recovery,manager_credit,manager_debit,marketing_expense,merchant_float_correction_writedown,merchant_oop_reimbursement,orphan_reassignment,orphan_reversal,partner_capital_cash_received,partner_commission,partner_funding,partner_receivable_capital,partner_receivable_collected,partner_receivable_created,partner_reward_accrued,payroll_expense,pending_portfolio_topup,platform_expense,platform_loss_writeoff,pool_capital_received,pool_rent_deployment_reversal,proxy_investment_commission,proxy_partner_withdrawal,reconciliation,referral_bonus,registration_fee_collected,rent_disbursement,rent_float_funding,rent_obligation,rent_obligation_reversal,rent_obligation_reversal_adjustment,rent_payment_for_tenant,rent_payment_received,rent_principal_collected,rent_receivable_created,rent_repayment,research_development_expense,roi_expense,roi_payout,roi_reinvestment,roi_wallet_credit,salary_advance,salary_advance_repayment,salary_payout,share_capital,supporter_capital,supporter_rent_fund,system_balance_correction,tax_expense,tenant_default_charge,tenant_repayment,tenant_rent_settlement,test_funds_cleanup,treasury_allocated,treasury_bank_deposit,treasury_fee_drawdown,treasury_fee_recognised,treasury_net_revenue,wallet_deduction,wallet_deduction_cash_payout_retraction,wallet_deduction_general_adjustment,wallet_deposit,wallet_to_investment,wallet_transfer,wallet_withdrawal}'::text[]
$function$;

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when)
VALUES ('platform','treasury_fee_drawdown',NULL,'L7','cash_out')
ON CONFLICT DO NOTHING;

-- 2. Auditable exceptions ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rent_fee_collection_exceptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id   uuid NOT NULL REFERENCES public.rent_requests(id),
  collection_id     uuid,
  source_table      text NOT NULL DEFAULT 'agent_collections',
  payment_amount    numeric NOT NULL,
  reason            text NOT NULL,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at       timestamptz,
  resolved_by       uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_fee_exception_unique UNIQUE (source_table, collection_id, reason)
);

CREATE INDEX IF NOT EXISTS rent_fee_exceptions_open_idx
  ON public.rent_fee_collection_exceptions (created_at DESC) WHERE resolved_at IS NULL;

ALTER TABLE public.rent_fee_collection_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "finance reads rent fee exceptions" ON public.rent_fee_collection_exceptions;
CREATE POLICY "finance reads rent fee exceptions"
ON public.rent_fee_collection_exceptions FOR SELECT TO authenticated
USING (public.is_budget_reviewer(auth.uid()) OR public.has_role(auth.uid(),'cfo')
       OR public.has_role(auth.uid(),'financial_ops') OR public.has_role(auth.uid(),'super_admin'));

GRANT SELECT ON public.rent_fee_collection_exceptions TO authenticated;
GRANT ALL    ON public.rent_fee_collection_exceptions TO service_role;

-- 3. The fee-collection posting -----------------------------------------
-- Callable from any rent collection route. Deliberately does NOT touch
-- amount_repaid, repayments or commission: the calling route already owns those,
-- and calling record_rent_request_repayment_v2 from a route that updates
-- amount_repaid would double-increment it.
CREATE OR REPLACE FUNCTION public.post_rent_fee_collection(
  p_rent_request_id uuid, p_payment_amount numeric, p_source_table text, p_source_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  a record; v_inst uuid := gen_random_uuid(); v_grp uuid; v_fees numeric; v_key text; v_recog boolean;
BEGIN
  IF p_rent_request_id IS NULL OR COALESCE(p_payment_amount,0) <= 0 THEN
    RETURN jsonb_build_object('status','no_op');
  END IF;

  -- Legacy plans keep their existing behaviour entirely.
  IF NOT public.is_treasury_waterfall_scope(p_rent_request_id) THEN
    RETURN jsonb_build_object('status','out_of_scope_legacy');
  END IF;

  -- Idempotency: one allocation per (plan, source row). Also enforced by
  -- uq_instalment_alloc_source, so a concurrent retry loses on the constraint.
  IF EXISTS (SELECT 1 FROM instalment_allocations ia
              WHERE ia.rent_request_id=p_rent_request_id AND ia.source_table=p_source_table
                AND ia.source_id=p_source_id) THEN
    RETURN jsonb_build_object('status','already_allocated');
  END IF;

  SELECT EXISTS (SELECT 1 FROM general_ledger gl
     WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
       AND gl.source_table='rent_requests' AND gl.source_id=p_rent_request_id) INTO v_recog;

  -- Never fail a tenant's rent payment over a bookkeeping gap.
  IF NOT v_recog THEN
    INSERT INTO rent_fee_collection_exceptions
      (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
    VALUES (p_rent_request_id, p_source_id, p_source_table, p_payment_amount,
            'funding_treasury_recognition_missing',
            jsonb_build_object(
              'note','Payment processed. Fee allocation and L7 drawdown skipped: no funding-side treasury_fee_recognised leg exists for this plan, so drawing down L7 would create a balance never recognised.',
              'remedy','Run recognise_funding_treasury() for this rent_request, then replay allocation for this collection.'))
    ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
    RETURN jsonb_build_object('status','skipped_no_funding_recognition');
  END IF;

  -- Existing pricing rules only. allocate_instalment applies cumulative
  -- true-up: it allocates the running total and subtracts what was already
  -- allocated, so each instalment's components sum EXACTLY to that payment and
  -- can never drift across instalments.
  SELECT * INTO a FROM public.allocate_instalment(p_rent_request_id, p_payment_amount);
  IF (COALESCE(a.principal_component,0)+COALESCE(a.registration_fee_component,0)
      +COALESCE(a.access_fee_component,0)) <= 0 THEN
    RETURN jsonb_build_object('status','no_allocation');
  END IF;
  v_fees := COALESCE(a.registration_fee_component,0) + COALESCE(a.access_fee_component,0);

  INSERT INTO instalment_allocations
    (rent_request_id, instalment_id, instalment_amount, principal_component,
     registration_fee_component, access_fee_component,
     partner_reward_component, agent_commission_component, platform_net_component,
     source_table, source_id)
  VALUES (p_rent_request_id, v_inst, ROUND(p_payment_amount),
          a.principal_component, a.registration_fee_component, a.access_fee_component,
          NULL, NULL, NULL, p_source_table, p_source_id);

  -- A pure-principal instalment correctly produces no fee revenue.
  IF v_fees > 0 THEN
    v_key := 'rent-fee-collection:' || p_source_table || ':' || p_source_id::text;
    SELECT public.create_ledger_transaction(
      entries := (
        jsonb_build_array(jsonb_build_object(
          'direction','cash_out','amount', v_fees, 'category','treasury_fee_drawdown',
          'ledger_scope','platform','source_table',p_source_table,'source_id',p_source_id::text,
          'reference_id',v_inst::text,'currency','UGX','transaction_date',now(),
          'description','Deferred fee revenue drawn down on tenant rent collection'))
        || CASE WHEN COALESCE(a.registration_fee_component,0) > 0 THEN
             jsonb_build_array(jsonb_build_object(
               'direction','cash_in','amount', a.registration_fee_component,
               'category','registration_fee_collected','ledger_scope','platform',
               'source_table',p_source_table,'source_id',p_source_id::text,
               'reference_id',v_inst::text,'currency','UGX','transaction_date',now(),
               'description','Registration fee collected from tenant rent payment'))
           ELSE '[]'::jsonb END
        || CASE WHEN COALESCE(a.access_fee_component,0) > 0 THEN
             jsonb_build_array(jsonb_build_object(
               'direction','cash_in','amount', a.access_fee_component,
               'category','access_fee_collected','ledger_scope','platform',
               'source_table',p_source_table,'source_id',p_source_id::text,
               'reference_id',v_inst::text,'currency','UGX','transaction_date',now(),
               'description','Access fee collected from tenant rent payment'))
           ELSE '[]'::jsonb END
      ), idempotency_key := v_key) INTO v_grp;
    UPDATE instalment_allocations SET transaction_group_id = v_grp WHERE instalment_id = v_inst;
  END IF;

  RETURN jsonb_build_object('status','posted','instalment_id',v_inst,
    'transaction_group_id',v_grp,'payment_amount',ROUND(p_payment_amount),
    'principal',a.principal_component,'registration_fee_collected',a.registration_fee_component,
    'access_fee_collected',a.access_fee_component,'total_fees_collected',v_fees);
END;
$function$;

REVOKE ALL ON FUNCTION public.post_rent_fee_collection(uuid,numeric,text,uuid) FROM public;

-- 4. CFO report ----------------------------------------------------------
-- Anchored on instalment_allocations, NEVER on category alone.
CREATE OR REPLACE FUNCTION public.get_cfo_rent_fee_collections(p_as_at date DEFAULT CURRENT_DATE)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_day jsonb; v_mtd jsonb;
BEGIN
  IF v_uid IS NOT NULL AND NOT (
       public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'ceo')
       OR public.has_role(v_uid,'financial_ops') OR public.has_role(v_uid,'manager')
       OR public.has_role(v_uid,'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised to view Platform Treasury rent fee collections';
  END IF;
  WITH scoped AS (
    SELECT ia.*, (ia.created_at AT TIME ZONE 'Africa/Kampala')::date AS d FROM instalment_allocations ia
  ), agg AS (
    SELECT 'day' AS bucket, COALESCE(SUM(instalment_amount),0) AS collections,
           COALESCE(SUM(principal_component),0) AS principal,
           COALESCE(SUM(registration_fee_component),0) AS registration,
           COALESCE(SUM(access_fee_component),0) AS access, COUNT(*) AS payments
    FROM scoped WHERE d = p_as_at
    UNION ALL
    SELECT 'mtd', COALESCE(SUM(instalment_amount),0), COALESCE(SUM(principal_component),0),
           COALESCE(SUM(registration_fee_component),0), COALESCE(SUM(access_fee_component),0), COUNT(*)
    FROM scoped WHERE d >= date_trunc('month', p_as_at)::date AND d <= p_as_at
  )
  SELECT
    (SELECT jsonb_build_object('total_rent_collections',collections,'principal_collected',principal,
      'registration_fees_collected',registration,'access_fees_collected',access,
      'total_fees_collected',registration+access,'platform_treasury_fee_revenue',registration+access,
      'payment_count',payments) FROM agg WHERE bucket='day'),
    (SELECT jsonb_build_object('total_rent_collections',collections,'principal_collected',principal,
      'registration_fees_collected',registration,'access_fees_collected',access,
      'total_fees_collected',registration+access,'platform_treasury_fee_revenue',registration+access,
      'payment_count',payments) FROM agg WHERE bucket='mtd')
  INTO v_day, v_mtd;
  RETURN jsonb_build_object('as_at',p_as_at,'daily',v_day,'mtd',v_mtd,
    'basis','Collection-driven. Anchored on instalment_allocations written only by post_rent_fee_collection; excludes all non-rent use of the shared R1 fee categories.',
    'open_exceptions',(SELECT count(*) FROM rent_fee_collection_exceptions WHERE resolved_at IS NULL));
END;
$function$;

-- 5. Drill-down ----------------------------------------------------------
CREATE OR REPLACE VIEW public.v_rent_fee_collection_drilldown AS
SELECT (ia.created_at AT TIME ZONE 'Africa/Kampala')::date AS collected_on,
       ia.created_at AS collected_at, rr.tenant_id, tp.full_name AS tenant_name,
       ia.rent_request_id, rr.rent_amount, rr.access_fee,
       rr.request_fee AS registration_fee_billed, rr.total_repayment,
       ia.instalment_amount AS payment_amount, ia.principal_component,
       ia.registration_fee_component, ia.access_fee_component,
       (ia.registration_fee_component + ia.access_fee_component) AS platform_treasury_fee_revenue,
       ia.source_table, ia.source_id AS collection_id,
       ac.collection_channel, ac.agent_id, ag.full_name AS agent_name,
       ia.transaction_group_id AS fee_ledger_group, ia.instalment_id
FROM instalment_allocations ia
JOIN rent_requests rr ON rr.id = ia.rent_request_id
LEFT JOIN profiles tp ON tp.id = rr.tenant_id
LEFT JOIN agent_collections ac ON ac.id = ia.source_id AND ia.source_table='agent_collections'
LEFT JOIN profiles ag ON ag.id = ac.agent_id;

GRANT SELECT ON public.v_rent_fee_collection_drilldown TO authenticated;

-- 6. Reconciliation ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_rent_fee_collections()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH grp AS (
    SELECT DISTINCT transaction_group_id AS g FROM instalment_allocations WHERE transaction_group_id IS NOT NULL
  ), r1 AS (
    SELECT gl.category, SUM(gl.amount) AS amt FROM general_ledger gl JOIN grp ON grp.g=gl.transaction_group_id
    WHERE gl.category IN ('registration_fee_collected','access_fee_collected') GROUP BY 1
  ), alloc AS (
    SELECT COALESCE(SUM(registration_fee_component),0) AS reg,
           COALESCE(SUM(access_fee_component),0) AS acc, COUNT(*) AS n,
           COUNT(*) FILTER (WHERE ROUND(principal_component+registration_fee_component
                                        +access_fee_component) <> ROUND(instalment_amount)) AS mism
    FROM instalment_allocations
  ), bal AS (
    SELECT count(*) AS unbal FROM (
      SELECT gl.transaction_group_id
      FROM general_ledger gl JOIN grp ON grp.g=gl.transaction_group_id
      LEFT JOIN ledger_account_map m ON m.ledger_scope=gl.ledger_scope AND m.category=gl.category AND m.wallet_bucket IS NULL
      GROUP BY 1
      HAVING abs(SUM(CASE WHEN gl.direction=COALESCE(m.debit_when,'cash_in') THEN gl.amount ELSE -gl.amount END))>0.5) x
  ), dupes AS (
    SELECT count(*) AS d FROM (SELECT rent_request_id,source_table,source_id FROM instalment_allocations
      GROUP BY 1,2,3 HAVING count(*)>1) y
  )
  SELECT jsonb_build_object(
    'check_1_registration', jsonb_build_object('allocations',(SELECT reg FROM alloc),
      'r1_legs',COALESCE((SELECT amt FROM r1 WHERE category='registration_fee_collected'),0),
      'pass',(SELECT reg FROM alloc)=COALESCE((SELECT amt FROM r1 WHERE category='registration_fee_collected'),0)),
    'check_2_access', jsonb_build_object('allocations',(SELECT acc FROM alloc),
      'r1_legs',COALESCE((SELECT amt FROM r1 WHERE category='access_fee_collected'),0),
      'pass',(SELECT acc FROM alloc)=COALESCE((SELECT amt FROM r1 WHERE category='access_fee_collected'),0)),
    'check_4_components_equal_payment', jsonb_build_object('mismatches',(SELECT mism FROM alloc),
      'pass',(SELECT mism FROM alloc)=0),
    'check_5_fee_groups_balance', jsonb_build_object('unbalanced',(SELECT unbal FROM bal),
      'pass',(SELECT unbal FROM bal)=0),
    'check_6_no_duplicate_allocations', jsonb_build_object('duplicates',(SELECT d FROM dupes),
      'pass',(SELECT d FROM dupes)=0),
    'allocations_total',(SELECT n FROM alloc),
    'open_exceptions',(SELECT count(*) FROM rent_fee_collection_exceptions WHERE resolved_at IS NULL));
$function$;

-- L7 per plan (check 3) and proof that non-rent R1 activity is excluded (check 7).
CREATE OR REPLACE FUNCTION public.reconcile_rent_fee_l7()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH billed AS (
    SELECT gl.source_id AS rr, SUM(gl.amount) AS billed FROM general_ledger gl
    WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
      AND gl.source_table='rent_requests' GROUP BY 1
  ), collected AS (
    SELECT ia.rent_request_id AS rr, SUM(ia.registration_fee_component+ia.access_fee_component) AS collected
    FROM instalment_allocations ia GROUP BY 1
  ), rent_groups AS (
    SELECT DISTINCT transaction_group_id AS g FROM instalment_allocations WHERE transaction_group_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'check_3_l7_per_plan', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
       'rent_request_id',b.rr,'fees_billed',b.billed,'fees_collected',COALESCE(c.collected,0),
       'l7_outstanding',b.billed-COALESCE(c.collected,0))),'[]'::jsonb)
       FROM billed b LEFT JOIN collected c ON c.rr=b.rr WHERE COALESCE(c.collected,0)>0),
    'l7_total_billed',(SELECT COALESCE(SUM(billed),0) FROM billed),
    'l7_total_collected',(SELECT COALESCE(SUM(collected),0) FROM collected),
    'check_7_non_rent_excluded', jsonb_build_object(
      'non_rent_r1_fee_activity',(SELECT COALESCE(SUM(CASE WHEN gl.direction='cash_in' THEN gl.amount ELSE -gl.amount END),0)
        FROM general_ledger gl WHERE gl.category IN ('registration_fee_collected','access_fee_collected')
          AND gl.ledger_scope='platform'
          AND NOT EXISTS (SELECT 1 FROM rent_groups rg WHERE rg.g=gl.transaction_group_id)),
      'note','Exists in R1 but deliberately excluded from every Landlord/Rent figure.'));
$function$;

-- 7. Assertions ----------------------------------------------------------
DO $$
DECLARE v_n integer;
BEGIN
  IF NOT public.validate_ledger_category('treasury_fee_drawdown') THEN
    RAISE EXCEPTION 'treasury_fee_drawdown not allowlisted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger_account_map WHERE ledger_scope='platform'
    AND category='treasury_fee_drawdown' AND account_code='L7' AND debit_when='cash_out') THEN
    RAISE EXCEPTION 'treasury_fee_drawdown mapping missing or wrong';
  END IF;

  -- The two approved R1 fee categories must be UNCHANGED.
  IF (SELECT debit_when FROM ledger_account_map WHERE category='registration_fee_collected') <> 'cash_out'
  OR (SELECT debit_when FROM ledger_account_map WHERE category='access_fee_collected') <> 'cash_out' THEN
    RAISE EXCEPTION 'existing R1 fee category mappings were altered';
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN
     ('post_rent_fee_collection','get_cfo_rent_fee_collections',
      'reconcile_rent_fee_collections','reconcile_rent_fee_l7');
  IF v_n <> 4 THEN RAISE EXCEPTION 'expected 4 new functions, found %', v_n; END IF;

  -- treasury_net_revenue must not be used by the new path.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='post_rent_fee_collection'
     AND position('treasury_net_revenue' in p.prosrc) > 0;
  IF v_n <> 0 THEN RAISE EXCEPTION 'post_rent_fee_collection must not use treasury_net_revenue'; END IF;

  -- The historical BD-3 leg must survive untouched.
  SELECT count(*) INTO v_n FROM general_ledger WHERE category='treasury_net_revenue';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 historical treasury_net_revenue leg, found %', v_n; END IF;

  -- A2 must not have been touched by this migration.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal'
     AND position('post_rent_fee_collection' in p.prosrc) > 0;
  IF v_n <> 0 THEN RAISE EXCEPTION 'agent collection route must not be wired in this migration'; END IF;
END $$;
