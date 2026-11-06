-- 2026-11-04: merchandise phase 3b - additional controls (CFO decisions 2026-11-04). Production apply needs explicit CFO
-- approval. Apply AFTER 20261104150000 (the preflight refuses otherwise). ACCOUNTING / ACCESS ONLY except item 6 (a report
-- filter): no wallet leg, payment, refund or order-status change.
--   1. Category agent_advance_memo_offset (platform -> L1), allowlisted.
--   2. record_advance_deduction_atomic, legacy branch only (advances before the A10/L8 late-fee engine): the daily overdue
--      penalty's company-side leg is agent_advance_memo_offset (DR L1, offsets the agent's advance_credit display) instead
--      of interest_expense (DR X1). The wallet leg, the advance and its ledger row, amounts and keys are unchanged.
--   3. One-off: per advance, DR L1 agent_advance_memo_offset / CR X1 interest_expense for the penalties posted so far
--      (14,959,494 at 2026-11-04 08:00, 335 advances; computed at apply time). A10 is not changed.
--   4. Paid merchandise sales with no money record (the CMO's "Record Sale" writes the sale and posts nothing): queued for
--      the CFO at commit (merchandise_unrecorded_sales); the 2 known sales (e9b076af 60,000; 9381fee7 35,000) queued.
--      Nothing posted: who received the cash is not evidenced.
--   5. recompute_wallet_buckets: EXECUTE stays with the owner and service_role only (re-revoked here; added to
--      scripts/guard-privileged-function-grants.mjs so no later migration can grant it to app users). It is not run.
--   6. get_partner_ops_returns_arrears (Partner Ops pledge preview): the same approved-order + confirmed-delivery gate as
--      the collection (merchandise_plan_recovery_eligible), so the preview matches what apply_smartphone_roi_pledge takes.
-- Rollback: supabase/rollbacks/20261104160000_merchandise_phase3b_controls.rollback.sql (functions, trigger, mapping if unused; posted entries and review rows stay).
-- Tests: src/test/merchandisePhase3.test.ts (phase 3b). TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
-- no daily deduction can post a penalty between the correction and the function change (both in this transaction)
LOCK TABLE public.agent_advance_ledger IN EXCLUSIVE MODE;

DO $pre$
DECLARE v_bad int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_account_map WHERE category = 'merchandise_payment_retained')
     OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE idempotency_key LIKE 'merch\_phase3\_20261104:%:RETAINED') <> 2 THEN
    RAISE EXCEPTION 'merchandise phase 3b: apply 20261104150000 first';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.record_advance_deduction_atomic(uuid, uuid, date, numeric, numeric, numeric, numeric, text, text, numeric, text, numeric, text, jsonb, text, jsonb)'))
       IS DISTINCT FROM 'a0b92c1cbf131b2050575c7658dfac1c'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_partner_ops_returns_arrears(uuid[])'))
       IS DISTINCT FROM 'f083c24dd1309f2acb6b93da67ef36b7'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.recompute_wallet_buckets(uuid)'))
       IS DISTINCT FROM '05c9a7562dd7178394db4eb46903aeff'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.ledger_category_allowlist()'))
       IS DISTINCT FROM '0cf8f4c90c5fc99832b276f8615a3423'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.merchandise_plan_recovery_eligible(uuid)'))
       IS DISTINCT FROM 'fd52204a0662a4353f1e1fb32c278ad2'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.create_ledger_transaction(jsonb, text, boolean)'))
       IS DISTINCT FROM '8e570ba579b151ac17788c0ee668a93b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.sofp_ledger_legs(timestamp with time zone)'))
       IS DISTINCT FROM '843ccf477014f8c7a8e0b5c6f14a1ba0' THEN
    RAISE EXCEPTION 'merchandise phase 3b: preflight refused - a function differs from the expected definition';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_account_map WHERE category = 'agent_advance_memo_offset')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE category = 'agent_advance_memo_offset')
     OR to_regclass('public.merchandise_unrecorded_sales') IS NOT NULL THEN
    RAISE EXCEPTION 'merchandise phase 3b: already applied';
  END IF;
  -- evidence: per advance, the penalty display in L1 (wallet advance_credit) equals the penalty expense in X1
  SELECT count(*) INTO v_bad FROM (
    SELECT g.source_id,
           sum(CASE WHEN g.ledger_scope = 'wallet' AND g.wallet_bucket = 'advance_credit' THEN CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END ELSE 0 END) l1,
           sum(CASE WHEN g.ledger_scope = 'platform' AND g.category = 'interest_expense' THEN CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END ELSE 0 END) x1
    FROM public.general_ledger g
    WHERE g.source_table = 'agent_advances'
      AND ((g.ledger_scope = 'wallet' AND g.wallet_bucket = 'advance_credit') OR (g.ledger_scope = 'platform' AND g.category = 'interest_expense'))
    GROUP BY 1 HAVING sum(CASE WHEN g.ledger_scope = 'wallet' AND g.wallet_bucket = 'advance_credit' THEN CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END ELSE 0 END)
      <> sum(CASE WHEN g.ledger_scope = 'platform' AND g.category = 'interest_expense' THEN CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END ELSE 0 END)) z;
  IF v_bad <> 0 THEN RAISE EXCEPTION 'merchandise phase 3b: penalty evidence moved (% advances where L1 <> X1)', v_bad; END IF;
  -- evidence: the two paid sales with no money record
  SELECT count(*) INTO v_bad FROM (VALUES ('e9b076af-6e03-445e-8a43-f5bede640223'::uuid, 60000::numeric), ('9381fee7-5f0b-4c98-b15f-f25ad85be144'::uuid, 35000::numeric)) v(sale, paid)
  LEFT JOIN public.merchandise_sales s ON s.id = v.sale
  WHERE s.id IS NULL OR s.amount_paid <> v.paid OR s.order_status <> 'completed'
     OR EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.source_id = v.sale);
  IF v_bad <> 0 THEN RAISE EXCEPTION 'merchandise phase 3b: unrecorded-sale evidence moved (% sales)', v_bad; END IF;
END $pre$;

-- ---------------------------------------------------------------- 1. category
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes) VALUES
  ('platform', 'agent_advance_memo_offset', NULL, 'L1', 'cash_out',
   '2026-11-04 (CFO): offsets the overdue penalty shown on an agent''s advance (advance_credit); not money owed to the agent, not an expense');
CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT ((public.ledger_category_allowlist_base() || ARRAY[
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
    || ARRAY['agent_advance_memo_offset']::text[];
$function$;

-- ---------------------------------------------------------------- 2. daily penalty accrual (legacy advances): company-side leg only
CREATE OR REPLACE FUNCTION public.record_advance_deduction_atomic(p_advance_id uuid, p_agent_id uuid, p_date date, p_opening_balance numeric, p_interest_accrued numeric, p_amount_deducted numeric, p_closing_balance numeric, p_deduction_status text, p_new_status text, p_new_fee_collected numeric, p_fee_status text, p_new_arrears numeric, p_penalty_description text DEFAULT NULL::text, p_penalty_meta jsonb DEFAULT '{}'::jsonb, p_repayment_description text DEFAULT NULL::text, p_repayment_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_penalty_group   uuid;
  v_repayment_group uuid;
  v_alloc           jsonb;
  v_funding         jsonb;
  v_current public.agent_advances%ROWTYPE;
BEGIN
  IF p_advance_id IS NULL OR p_agent_id IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'record_advance_deduction_atomic: advance, agent and date are required';
  END IF;
  PERFORM public._prepare_bike_priority(p_agent_id);
  SELECT * INTO v_current FROM public.agent_advances WHERE id=p_advance_id AND agent_id=p_agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance owner mismatch' USING ERRCODE='42501'; END IF;
  IF v_current.status NOT IN ('active','overdue') OR COALESCE(v_current.deduction_paused,false) OR COALESCE(v_current.recovery_source,'wallet_daily')='roi' THEN
    RAISE EXCEPTION 'BIKE_PRIORITY_RECALCULATE: Advance eligibility changed' USING ERRCODE='40001';
  END IF;
  IF p_opening_balance IS DISTINCT FROM v_current.outstanding_balance OR
    (p_repayment_meta ? 'expected_arrears' AND (p_repayment_meta->>'expected_arrears')::numeric IS DISTINCT FROM COALESCE(v_current.arrears_balance,0)) THEN
    RAISE EXCEPTION 'BIKE_PRIORITY_RECALCULATE: Advance changed; refresh recovery amounts' USING ERRCODE='40001';
  END IF;
  IF COALESCE(p_amount_deducted,0)>public._prepare_bike_priority(p_agent_id) THEN
    RAISE EXCEPTION 'BIKE_PRIORITY_RECALCULATE: Bike payment has priority; refresh recovery amounts' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status)
  VALUES
    (p_advance_id, p_date, p_opening_balance, p_interest_accrued, p_amount_deducted,
     p_closing_balance, p_deduction_status);
  UPDATE public.agent_advances
  SET outstanding_balance  = GREATEST(0, p_closing_balance),
      status               = p_new_status,
      access_fee_collected = p_new_fee_collected,
      access_fee_status    = p_fee_status,
      arrears_balance      = p_new_arrears,
      updated_at           = now()
  WHERE id = p_advance_id;
  IF COALESCE(p_interest_accrued, 0) > 0 THEN
    IF public.agent_advance_is_post_effective(p_advance_id) THEN
      v_penalty_group := public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
            'amount', p_interest_accrued, 'category', 'agent_advance_penalty_accrued',
            'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Late Fee accrued and capitalised into the advance',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          ),
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', p_interest_accrued, 'category', 'agent_advance_penalty_unearned',
            'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Unearned Late Fee income held until collected',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          )
        ),
        idempotency_key => 'advance_late_fee:' || p_advance_id::text || ':' || p_date::text
      );
    ELSE
      v_penalty_group := public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
            'amount', p_interest_accrued, 'category', 'agent_advance_credit',
            'recipient_type', 'user', 'wallet_bucket', 'advance_credit',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', p_penalty_description,
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          ),
          -- 2026-11-04 (CFO): the penalty shown on the agent's advance (advance_credit) is a memo of what the agent owes,
          -- not money owed to the agent and not an expense: offset in L1 (was DR X1 interest_expense). Wallet leg unchanged.
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
            'amount', p_interest_accrued, 'category', 'agent_advance_memo_offset',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Overdue advance penalty shown on the agent''s advance (memo; not owed to the agent, not an expense)',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          )
        ),
        idempotency_key => 'advance_penalty_interest:' || p_advance_id::text || ':' || p_date::text
      );
    END IF;
  END IF;
  IF COALESCE(p_amount_deducted, 0) > 0 THEN
    v_funding := jsonb_build_array(
      jsonb_build_object(
        'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
        'amount', p_amount_deducted, 'category', 'agent_repayment',
        'recipient_type', 'user',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', p_repayment_description,
        'currency', 'UGX', 'transaction_date', p_date,
        'metadata', p_repayment_meta
      ));
    v_alloc := public.agent_advance_allocation_entries(
                 p_advance_id, p_agent_id, p_amount_deducted, p_date::timestamptz, false);
    IF v_alloc IS NULL THEN
      v_repayment_group := public.create_ledger_transaction(
        entries => v_funding || jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', p_amount_deducted, 'category', 'agent_repayment',
            'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Advance repayment received from agent',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_repayment_meta
          ))
      );
    ELSE
      v_repayment_group := public.create_ledger_transaction(entries => v_funding || v_alloc);
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'advance_id', p_advance_id,
    'amount_deducted', p_amount_deducted,
    'interest_accrued', p_interest_accrued,
    'closing_balance', GREATEST(0, p_closing_balance),
    'penalty_group_id', v_penalty_group,
    'repayment_group_id', v_repayment_group
  );
END;
$function$;

-- ---------------------------------------------------------------- 3. historical: agent-advance penalties shown in advance_credit
-- 335 legacy advances: each daily penalty posted DR X1 interest_expense / CR L1 (agent's advance_credit bucket, a display
-- of what the agent owes; not withdrawable, not owed to the agent). Per advance, the net in L1 equals the net in X1
-- (checked in the preflight). One new balanced group per advance, platform legs only: DR L1 agent_advance_memo_offset /
-- CR X1 interest_expense, for the advance's net. A10 is not touched (these penalties were never in A10; recognising them
-- there is a separate CFO policy decision). Wallets and the advance shown to agents are unchanged.
-- Idempotent (key agent_penalty_memo_offset_20261104:<advance>).
DO $penalty$
DECLARE r record; v_n int := 0; v_total numeric := 0;
BEGIN
  FOR r IN
    SELECT g.source_id AS adv, sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) AS net,
           min(g.created_at) AS first_at, max(g.created_at) AS last_at, count(*) AS legs
    FROM public.general_ledger g
    WHERE g.source_table = 'agent_advances' AND g.ledger_scope = 'wallet' AND g.wallet_bucket = 'advance_credit'
    GROUP BY 1 HAVING sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) > 0
    ORDER BY 1
  LOOP
    PERFORM public.create_ledger_transaction(entries => jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.net, 'category', 'agent_advance_memo_offset',
        'source_table', 'agent_advances', 'source_id', r.adv, 'currency', 'UGX',
        'description', 'Correction 2026-11-04 (CFO): overdue penalties shown on the agent''s advance (' || r.legs || ' entries, '
          || to_char(r.first_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD') || ' to ' || to_char(r.last_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD')
          || ') are not owed to the agent (L1)'),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.net, 'category', 'interest_expense',
        'source_table', 'agent_advances', 'source_id', r.adv, 'currency', 'UGX',
        'description', 'Correction 2026-11-04 (CFO): overdue penalties are not an expense of the company (X1)')),
      idempotency_key => 'agent_penalty_memo_offset_20261104:' || r.adv::text);
    v_n := v_n + 1; v_total := v_total + r.net;
  END LOOP;
  RAISE NOTICE 'agent-advance penalty memo offset: % advances, UGX %', v_n, v_total;
END $penalty$;

-- ---------------------------------------------------------------- 4. paid sales with no money record in the ledger
-- The Merchandise Manager's "Record Sale" (CMO) writes merchandise_sales directly, with an amount_paid, and posts nothing:
-- the cash is in no ledger account. Accounting-only control: at commit, a sale with a payment and no ledger entry on the
-- sale or its plans is queued here for the CFO (who received the cash, where it is). Nothing is posted: the counterpart
-- (bank, agent float, cash in transit) must be evidenced first.
CREATE TABLE public.merchandise_unrecorded_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL UNIQUE,
  item_name text, quantity numeric, total_revenue numeric, amount_paid numeric, unit_cost numeric,
  client_name text, customer_id uuid, recorded_by uuid, sale_date date, order_status text, payment_plan text,
  flags text[] NOT NULL DEFAULT '{}',          -- cash_not_in_ledger, off_platform_client, historical
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  decided_by uuid, decided_at timestamptz, decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.merchandise_unrecorded_sales IS
  'Merchandise sales recorded as paid with no ledger entry for the money (20261104160000). CFO review list; posts nothing.';
ALTER TABLE public.merchandise_unrecorded_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY cfo_reads_merch_unrecorded_sales ON public.merchandise_unrecorded_sales FOR SELECT TO authenticated
  USING ((select public.has_role((select auth.uid()), 'cfo'::app_role)) OR (select public.has_role((select auth.uid()), 'ceo'::app_role))
      OR (select public.has_role((select auth.uid()), 'coo'::app_role)) OR (select public.has_role((select auth.uid()), 'super_admin'::app_role)));
create policy mfa_required_for_staff on public.merchandise_unrecorded_sales as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
REVOKE ALL ON public.merchandise_unrecorded_sales FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.merchandise_unrecorded_sales TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_unrecorded_sales TO service_role;

CREATE OR REPLACE FUNCTION public._merch_unrecorded_sale_check(p_sale uuid, p_origin text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE s record; v_id uuid; v_flags text[] := ARRAY['cash_not_in_ledger'];
BEGIN
  SELECT * INTO s FROM public.merchandise_sales WHERE id = p_sale;
  IF NOT FOUND OR COALESCE(s.amount_paid, 0) <= 0 THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.general_ledger g
             WHERE (g.source_table = 'merchandise_sales' AND g.source_id = p_sale)
                OR (g.source_table = 'merchandise_recovery_plans'
                    AND g.source_id IN (SELECT p.id FROM public.merchandise_recovery_plans p WHERE p.sale_id = p_sale))) THEN
    RETURN NULL;
  END IF;
  IF s.customer_id IS NULL THEN v_flags := v_flags || 'off_platform_client'::text; END IF;
  IF p_origin = 'historical_20261104' THEN v_flags := v_flags || 'historical'::text; END IF;
  INSERT INTO public.merchandise_unrecorded_sales (sale_id, item_name, quantity, total_revenue, amount_paid, unit_cost, client_name,
    customer_id, recorded_by, sale_date, order_status, payment_plan, flags)
  VALUES (p_sale, s.item_name, s.quantity, s.total_revenue, s.amount_paid, s.unit_cost, s.client_name, s.customer_id, s.created_by,
    s.sale_date, s.order_status, s.payment_plan, v_flags)
  ON CONFLICT (sale_id) DO UPDATE SET amount_paid = EXCLUDED.amount_paid, order_status = EXCLUDED.order_status, updated_at = now()
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 'merchandise_unrecorded_sale_queued', 'merchandise_unrecorded_sales', v_id::text, p_origin,
          jsonb_build_object('sale_id', p_sale, 'amount_paid', s.amount_paid, 'flags', v_flags));
  RETURN v_id;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_merch_unrecorded_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- deferred to commit: a sale paid through the wallet posts its ledger entries in the same transaction
  PERFORM public._merch_unrecorded_sale_check(NEW.id, 'sale');
  RETURN NULL;
END $function$;
CREATE CONSTRAINT TRIGGER trg_merch_unrecorded_sale AFTER INSERT OR UPDATE OF amount_paid ON public.merchandise_sales
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (COALESCE(NEW.amount_paid, 0) > 0)
  EXECUTE FUNCTION public.trg_merch_unrecorded_sale();
REVOKE ALL ON FUNCTION public._merch_unrecorded_sale_check(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_merch_unrecorded_sale() FROM PUBLIC, anon, authenticated;
SELECT public._merch_unrecorded_sale_check(v.sale, 'historical_20261104') FROM (VALUES
  ('e9b076af-6e03-445e-8a43-f5bede640223'::uuid), ('9381fee7-5f0b-4c98-b15f-f25ad85be144'::uuid)) v(sale);

-- ---------------------------------------------------------------- 5. recompute_wallet_buckets: owner and service_role only
-- Called only by the coo-create-portfolio edge function (service role, non-blocking). It cannot change a withdrawable
-- balance today (the wallets view's update trigger writes only locked_balance and currency), but it would derive
-- withdrawable from advance_credit if that changed; no app user may call it.
REVOKE EXECUTE ON FUNCTION public.recompute_wallet_buckets(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_wallet_buckets(uuid) TO service_role;

-- ---------------------------------------------------------------- 6. Partner Ops pledge preview: eligible orders only
CREATE OR REPLACE FUNCTION public.get_partner_ops_returns_arrears(p_portfolio_ids uuid[])
 RETURNS TABLE(portfolio_id uuid, investor_id uuid, expected_returns numeric, pledge_mode text, pledge_value numeric, arrears_deduction numeric, net_payout numeric, plan_outstanding numeric, plan_overdue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.is_partner_ops(auth.uid()) OR public.can_view_staff_reports(auth.uid())) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH pf AS (
    SELECT ip.id, ip.investor_id AS owner_id, ip.created_at,
           round(COALESCE(ip.investment_amount, 0) * COALESCE(ip.roi_percentage, 15) / 100.0) AS expected
    FROM public.investor_portfolios ip
    WHERE ip.id = ANY (COALESCE(p_portfolio_ids, ARRAY[]::uuid[]))
  ),
  pledge AS (
    SELECT sp.user_id, sp.mode, sp.value
    FROM public.smartphone_roi_pledges sp
    WHERE sp.active
  ),
  plan AS (
    SELECT DISTINCT ON (p.customer_id)
           p.customer_id, p.outstanding_balance, COALESCE(p.due_balance, 0) AS overdue
    FROM public.merchandise_recovery_plans p
    JOIN public.merchandise_sales s ON s.id = p.sale_id
    WHERE p.status = 'active' AND p.outstanding_balance > 0
      AND NOT COALESCE(p.is_bike_lease, false) AND s.item_name ILIKE '%smartphone%'
      -- 2026-11-04 (CFO): the same gate as the collection (apply_smartphone_roi_pledge): approved, delivered orders only
      AND public.merchandise_plan_recovery_eligible(p.id)
    ORDER BY p.customer_id, p.created_at
  ),
  raw AS (
    SELECT pf.id, pf.owner_id, pf.created_at, pf.expected,
           pl.mode, pl.value, pn.outstanding_balance, pn.overdue,
           LEAST(
             CASE WHEN pl.mode = 'percent' THEN floor(pf.expected * pl.value / 100) ELSE pl.value END,
             pf.expected
           ) AS wanted
    FROM pf
    JOIN pledge pl ON pl.user_id = pf.owner_id
    JOIN plan pn ON pn.customer_id = pf.owner_id
  )
  SELECT r.id, r.owner_id, r.expected, r.mode, r.value,
         d.ded, r.expected - d.ded, r.outstanding_balance, r.overdue
  FROM raw r
  CROSS JOIN LATERAL (
    SELECT GREATEST(0, LEAST(
      r.wanted,
      r.outstanding_balance - COALESCE((
        SELECT sum(r2.wanted) FROM raw r2
        WHERE r2.owner_id = r.owner_id AND (r2.created_at, r2.id) < (r.created_at, r.id)
      ), 0)
    )) AS ded
  ) d
  ORDER BY r.owner_id, r.created_at, r.id;
END
$function$;

-- ---------------------------------------------------------------- 7. post-checks
DO $post$
DECLARE v_n int; v_amt numeric;
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.record_advance_deduction_atomic(uuid, uuid, date, numeric, numeric, numeric, numeric, text, text, numeric, text, numeric, text, jsonb, text, jsonb)'))
       IS DISTINCT FROM '16782f16b9cd70d2fbd571222480bcd4'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_partner_ops_returns_arrears(uuid[])'))
       IS DISTINCT FROM 'df8f151c699f3957a1ca15786f845d9b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.recompute_wallet_buckets(uuid)'))
       IS DISTINCT FROM '05c9a7562dd7178394db4eb46903aeff'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.ledger_category_allowlist()'))
       IS DISTINCT FROM 'a0b16c76ba26df42d9646c75760dce87'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_unrecorded_sale_check(uuid, text)'))
       IS DISTINCT FROM '18645da6462024af7ae7eb0ceb279f32'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.trg_merch_unrecorded_sale()'))
       IS DISTINCT FROM 'c148ad68771d5231a070ea02d7fd13ed' THEN
    RAISE EXCEPTION 'merchandise phase 3b: post-check failed (function fingerprints)';
  END IF;
  IF NOT (public.ledger_category_allowlist() @> ARRAY['agent_advance_memo_offset']) THEN
    RAISE EXCEPTION 'merchandise phase 3b: category not allowlisted';
  END IF;
  -- per advance: the penalty display in L1 is fully offset and X1 carries no penalty expense
  SELECT count(*) INTO v_n FROM (
    SELECT g.source_id FROM public.general_ledger g
    WHERE g.source_table = 'agent_advances'
      AND ((g.ledger_scope = 'wallet' AND g.wallet_bucket = 'advance_credit') OR g.category IN ('agent_advance_memo_offset', 'interest_expense'))
    GROUP BY 1
    HAVING sum(CASE WHEN g.ledger_scope = 'wallet' THEN CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END
                    WHEN g.category = 'agent_advance_memo_offset' THEN CASE WHEN g.direction = 'cash_out' THEN -g.amount ELSE g.amount END ELSE 0 END) <> 0
        OR sum(CASE WHEN g.category = 'interest_expense' THEN CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END ELSE 0 END) <> 0) z;
  IF v_n <> 0 THEN RAISE EXCEPTION 'merchandise phase 3b: % advances still carry a penalty in L1 or X1', v_n; END IF;
  -- every correction group: two platform legs, balanced raw and on mapped accounts
  SELECT count(*) INTO v_n FROM (
    SELECT g.transaction_group_id FROM public.general_ledger g
    JOIN public.ledger_account_map m ON m.ledger_scope = g.ledger_scope AND m.category = g.category AND m.wallet_bucket IS NULL
    WHERE g.idempotency_key LIKE 'agent\_penalty\_memo\_offset\_20261104:%' GROUP BY 1
    HAVING count(*) <> 2 OR bool_or(g.ledger_scope <> 'platform')
        OR sum(CASE WHEN g.direction = m.debit_when THEN g.amount ELSE -g.amount END) <> 0
        OR sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) <> 0) z;
  IF v_n <> 0 THEN RAISE EXCEPTION 'merchandise phase 3b: % unbalanced penalty correction groups', v_n; END IF;
  IF (SELECT count(*) FROM public.merchandise_unrecorded_sales WHERE 'historical' = ANY (flags)) <> 2 THEN
    RAISE EXCEPTION 'merchandise phase 3b: the two unrecorded sales are not queued';
  END IF;
  IF has_function_privilege('anon', 'public.recompute_wallet_buckets(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.recompute_wallet_buckets(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.recompute_wallet_buckets(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._merch_unrecorded_sale_check(uuid, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.merchandise_unrecorded_sales', 'INSERT')
     OR has_table_privilege('anon', 'public.merchandise_unrecorded_sales', 'SELECT')
     OR NOT has_function_privilege('authenticated', 'public.get_partner_ops_returns_arrears(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'merchandise phase 3b: grants not as intended';
  END IF;
END $post$;
