-- 2026-11-04: merchandise phase 3. Production apply needs explicit CFO approval.
-- Builds on 20261104090000 (27 one-off corrections) and 20261104100000 (receivable controls); repeats neither.
-- ACCOUNTING ONLY except item 5, which the CFO asked for explicitly. No wallet leg, refund, payment or order status changes.
--   1. Categories: merchandise_revenue (platform -> R1; already used by agent_purchase_merchandise, which would fail under
--      strict mode while it was unmapped and not allowlisted) and merchandise_advance_memo_offset (platform -> L1).
--   2. Smartphone payouts (cfo_disburse_smartphone_order), company-side legs only: the phone's cost is the A12 receivable
--      (was X1 expense) and the advance shown on the agent's wallet is offset in L1 (was a second A12 debit).
--   3. One-off: 8 historical payouts, DR L1 / CR X1 5,245,000 (the X1 expense and the L1 agent memo counted the same phone).
--   4. Company stock issued on credit (CFO decision 2026-11-04: sales revenue, never E3): queued for the CFO in
--      merchandise_stock_recognitions (one row per order) on every issue path. The receivable and the revenue
--      (DR A12/A13 / CR R1 merchandise_revenue) are recognised ONLY on verified delivery evidence:
--        * a handover record (merchandise_sales.handed_over_at AND handed_over_by, set by confirm_merchandise_handover):
--          recognised automatically in the same transaction (stock_issue_counterpart = 'revenue', set here); or
--        * a delivery document the CFO has verified (signed delivery note / acknowledgement), recorded with
--          cfo_post_merchandise_stock_recognition(id, evidence) - at least 20 characters naming the document.
--      NOT evidence: the order status alone (issued / approved / completed) and customer payments (a customer paid
--      34,929 on the undelivered pending order fdb05fd5). Items without evidence stay pending in the queue.
--   5. Monthly Returns smartphone pledge (apply_smartphone_roi_pledge): collects only on an approved, delivered order
--      (merchandise_plan_recovery_eligible); an ineligible order is skipped and recorded in audit_logs. Accounting
--      unchanged; the Returns payout is never affected.
--   6. The 7 historical company-stock items (1,015,000): none has a handover record or other delivery evidence, so all
--      7 stay pending in the queue (nothing posted).
--   7. Rejected motorcycle plans (CFO policy 2026-11-04): a rejected plan ends and the customer is NOT refunded; the
--      payments are retained by the company. The 2 plans rejected on 6 Oct (Martin Lukwago 109,451 paid 2-6 Aug;
--      Peter Bukoma 103.48 paid 24 Sep) sit as a credit in E3 after the 22 Sep restatement and J5. Retention happened at
--      rejection (6 Oct, current period), so it is income: DR E3 / CR R1 merchandise_payment_retained (new mapped
--      category). Review rows are flagged retained_payment, not possible_refund. Future rejected / cancelled bike
--      plans: cash collected is classified retained_payment and the CFO recognises a credit balance as retained income
--      ('retained' counterpart). No refund, no wallet change; reject_bike_lease is unchanged.
-- Rollback: supabase/rollbacks/20261104150000_merchandise_phase3_stock_phone_pledge.rollback.sql (functions, triggers and mapping; posted entries and review rows stay).
-- Tests: src/test/merchandisePhase3.test.ts. TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
DECLARE v_bad int;
BEGIN
  -- the one-off corrections and the receivable controls are in place (this builds on them; never repeats them)
  IF to_regclass('public.merchandise_accounting_controls') IS NULL OR to_regclass('public.merchandise_receivable_derecognitions') IS NULL
     OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE idempotency_key LIKE 'merch\_a12\_a13\_correction\_20261104:%') <> 27 THEN
    RAISE EXCEPTION 'merchandise phase 3: apply 20261104090000 and 20261104100000 first';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_disburse_smartphone_order(uuid, numeric, text)'))
       IS DISTINCT FROM 'a3642e31906685a7cee1dbea3462ea1e'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.apply_smartphone_roi_pledge(uuid, numeric, text)'))
       IS DISTINCT FROM '74ae9dca248b4b92e6e81a3bd472d997'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.ledger_category_allowlist()'))
       IS DISTINCT FROM 'd1b408552ac7f96bb3b84a286261c7fd'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.create_ledger_transaction(jsonb, text, boolean)'))
       IS DISTINCT FROM '8e570ba579b151ac17788c0ee668a93b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.sofp_ledger_legs(timestamp with time zone)'))
       IS DISTINCT FROM '843ccf477014f8c7a8e0b5c6f14a1ba0'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_receivable_net(uuid, uuid[], boolean)'))
       IS DISTINCT FROM '6e6a67f7d0926adbd9845aa12c8dca66'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_receivable_event(uuid, uuid, text)'))
       IS DISTINCT FROM 'bbea4b509dbf340a522ac66ad1ddb8c7'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_post_derecognition(uuid, text, text, uuid)'))
       IS DISTINCT FROM '0cfb35ac332e0b1cc3241efcbb2f3cdb'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_post_merchandise_derecognition(uuid, text, text)'))
       IS DISTINCT FROM '6979a4c7a26c1800c9adf15d90f5a4e9'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.merchandise_plan_recovery_eligible(uuid)'))
       IS DISTINCT FROM 'fd52204a0662a4353f1e1fb32c278ad2'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.merchandise_plan_ineligible_reason(uuid)'))
       IS DISTINCT FROM '44555b63befb3652e1bb7be108505bb6' THEN
    RAISE EXCEPTION 'merchandise phase 3: preflight refused - a function differs from the production definition of 2026-11-04';
  END IF;
  IF to_regclass('public.merchandise_stock_recognitions') IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.ledger_account_map WHERE category IN ('merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained'))
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE category IN ('merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained')) THEN
    RAISE EXCEPTION 'merchandise phase 3: already applied (or the categories are already in use)';
  END IF;
  IF (SELECT count(*) FROM public.ledger_account_map m WHERE m.wallet_bucket IS NULL AND (m.ledger_scope, m.category, m.account_code, m.debit_when) IN (
        ('platform', 'equipment_expense', 'X1', 'cash_out'), ('platform', 'smartphone_advance_receivable', 'A12', 'cash_out'),
        ('platform', 'bike_recovery_repayment', 'A13', 'cash_out'), ('bridge', 'merchandise_recovery_receivable_opening', 'A12', 'cash_in'),
        ('bridge', 'bike_recovery_receivable_opening', 'A13', 'cash_in'), ('platform', 'receivable_restatement_equity', 'E3', 'cash_in'))) <> 6 THEN
    RAISE EXCEPTION 'merchandise phase 3: ledger_account_map not as expected';
  END IF;
  -- evidence, per smartphone payout: exactly one X1 supplier-payment leg and one agent wallet advance memo of the price
  SELECT count(*) INTO v_bad FROM (VALUES
    ('9b704619-2d97-44cb-a61e-5ba7ac6525f6'::uuid, 165000::numeric),
    ('8c6a5ae9-8b38-42cd-a8aa-486dc95a298e'::uuid, 165000::numeric),
    ('3d11c494-31b9-468a-a638-24921a83a0b5'::uuid, 700000::numeric),
    ('548c49eb-d62b-4901-a3dd-7f745377a469'::uuid, 1500000::numeric),
    ('85bce373-09ee-4d15-b130-8380e81fea0a'::uuid, 165000::numeric),
    ('0a128951-9353-47c3-b51a-203e257ab582'::uuid, 800000::numeric),
    ('561e4919-4a93-4961-a33f-5900d0f11276'::uuid, 800000::numeric),
    ('c60db3db-334d-453e-89b8-aa1557535778'::uuid, 950000::numeric)) v(sale, amt)
  WHERE (SELECT count(*) FROM public.general_ledger g WHERE g.source_table = 'merchandise_sales' AND g.source_id = v.sale
           AND g.ledger_scope = 'platform' AND g.category = 'equipment_expense' AND g.direction = 'cash_out' AND g.amount = v.amt) <> 1
     OR (SELECT count(*) FROM public.general_ledger g WHERE g.source_table = 'merchandise_sales' AND g.source_id = v.sale
           AND g.ledger_scope = 'wallet' AND g.category = 'agent_advance_credit' AND g.wallet_bucket = 'advance_credit'
           AND g.direction = 'cash_in' AND g.amount = v.amt) <> 1
     OR EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key LIKE 'merch_phase3_20261104:' || v.sale::text || ':%');
  IF v_bad <> 0 THEN RAISE EXCEPTION 'merchandise phase 3: smartphone payout evidence moved (% sales)', v_bad; END IF;
  -- evidence, per company-stock item: issued, no payout, nothing recognised yet, the order total as queued
  SELECT count(*) INTO v_bad FROM (VALUES
    ('cdd33740-b2ee-47ab-b49d-1c7a4e23db7b'::uuid, 55000::numeric),
    ('9a8b2824-1241-40a1-b2ec-77519a66d2d4'::uuid, 55000::numeric),
    ('d99c3173-a6c9-4168-af94-02e695cb398c'::uuid, 55000::numeric),
    ('ded6710e-1a30-4f17-9f24-463de40081d4'::uuid, 55000::numeric),
    ('bf40085c-dedc-44ef-9e38-d6170a57209a'::uuid, 650000::numeric),
    ('4cf491c5-21b0-4366-9369-7a210b431013'::uuid, 110000::numeric),
    ('882c5336-b5b0-4108-bbc3-11b004dde5c3'::uuid, 35000::numeric)) v(sale, amt)
  LEFT JOIN public.merchandise_sales s ON s.id = v.sale
  WHERE s.id IS NULL OR s.order_status <> 'issued' OR s.cfo_disbursed_at IS NOT NULL OR s.total_revenue <> v.amt
     OR (public._merch_receivable_net(v.sale, (SELECT array_agg(p.id) FROM public.merchandise_recovery_plans p WHERE p.sale_id = v.sale), false)->>'a12')::numeric
        NOT IN (0, -6410);
  IF v_bad <> 0 THEN RAISE EXCEPTION 'merchandise phase 3: company-stock evidence moved (% orders)', v_bad; END IF;
  -- evidence, per rejected motorcycle plan: rejected order, the cash collected, A13 cleared by J5, nothing retained yet
  SELECT count(*) INTO v_bad FROM (VALUES
    ('dddc2333-efb2-4855-9ab7-f3d5c3793873'::uuid, '08f711e2-927a-43dd-bce0-73831c4dd16a'::uuid, 109451::numeric),
    ('54c4c664-6004-4aab-a56c-b285050633cd'::uuid, '9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0'::uuid, 103.48::numeric)) v(sale, plan, cash)
  LEFT JOIN public.merchandise_sales s ON s.id = v.sale
  WHERE s.id IS NULL OR s.order_status <> 'rejected'
     OR (public._merch_receivable_net(v.sale, ARRAY[v.plan], true)->>'a13')::numeric <> 0
     OR (public._merch_receivable_net(v.sale, ARRAY[v.plan], true)->>'cash')::numeric <> v.cash
     OR NOT EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key LIKE 'merch\_a12\_a13\_correction\_20261104:' || v.plan::text || ':DEREC')
     OR EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = 'merch_phase3_20261104:' || v.sale::text || ':RETAINED');
  IF v_bad <> 0 THEN RAISE EXCEPTION 'merchandise phase 3: rejected-motorcycle evidence moved (% plans)', v_bad; END IF;
END $pre$;

-- ---------------------------------------------------------------- 1. categories
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes) VALUES
  ('platform', 'merchandise_revenue', NULL, 'R1', 'cash_out', '2026-11-04 (CFO): merchandise sales revenue (company stock sold on credit or for cash)'),
  ('platform', 'merchandise_advance_memo_offset', NULL, 'L1', 'cash_out',
   '2026-11-04 (CFO): offsets the advance shown on an agent''s wallet (advance_credit) for goods the company paid for; not money owed to the agent'),
  ('platform', 'merchandise_payment_retained', NULL, 'R1', 'cash_in',
   '2026-11-04 (CFO policy): customer payments retained when a motorcycle plan is rejected (no refund). Post cash_out to CREDIT R1.');

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
    || ARRAY['merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained']::text[];
$function$;

-- ---------------------------------------------------------------- 2. smartphone payout: company-side legs only
CREATE OR REPLACE FUNCTION public.cfo_disburse_smartphone_order(p_sale_id uuid, p_amount numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_price numeric;
  v_total numeric;
  v_daily numeric;
  v_days integer;
  v_months integer;
  v_full boolean;
  v_sched jsonb;
  v_start date;
  v_ref text;
  v_adv_ref text;
  v_group uuid;
  v_adv_group uuid;
  v_supplier uuid;
  v_agent uuid;
  v_agent_name text;
  v_agent_phone text;
  v_supplier_name text;
  v_plan_id uuid;
BEGIN

  IF auth.uid() IS NOT NULL AND NOT public.is_cfo_approver(auth.uid()) THEN
    RAISE EXCEPTION 'This request could not be completed';
  END IF;
  IF NOT public.can_cfo_disburse_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to disburse smartphone advances';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'coo_approved' THEN
    RAISE EXCEPTION 'Application must be COO approved first (currently %)', COALESCE(v_sale.order_status, 'submitted');
  END IF;
  IF v_sale.customer_id IS NULL THEN
    RAISE EXCEPTION 'Application has no linked agent account';
  END IF;

  v_agent := v_sale.customer_id;

  v_supplier := v_sale.supplier_id;
  IF v_supplier IS NULL THEN
    SELECT supplier_id INTO v_supplier FROM public.smartphone_catalog WHERE id = v_sale.smartphone_catalog_id;
  END IF;
  IF v_supplier IS NULL THEN
    RAISE EXCEPTION 'No registered supplier is attached to this phone';
  END IF;
  IF v_supplier = v_agent THEN
    RAISE EXCEPTION 'The supplier and the applying agent cannot be the same person';
  END IF;

  v_price := COALESCE(NULLIF(p_amount, 0), NULLIF(v_sale.total_amount, 0), NULLIF(v_sale.unit_price, 0), 0);
  IF v_price <= 0 THEN
    RAISE EXCEPTION 'Phone price is missing on this application';
  END IF;

  -- payment_plan defaults to 'full' on every application, so it is not a
  -- reliable signal. A chosen period of 1-12 months is always instalments.
  v_full := COALESCE(v_sale.advance_period_months, 0) NOT BETWEEN 1 AND 12;
  v_months := CASE WHEN v_full THEN NULL ELSE v_sale.advance_period_months END;
  v_start := current_date + COALESCE(NULLIF(v_sale.grace_days, 0), 7);

  IF v_full THEN
    v_sched := jsonb_build_object('payment_plan', 'full', 'total_repayable', v_price);
    PERFORM public.smartphone_rebuild_repayment_schedule(p_sale_id, v_price, NULL, v_start);
    v_total := v_price;
    v_daily := v_price;
    v_days := 1;
    v_start := current_date;
  ELSE
    v_sched := public.smartphone_rebuild_repayment_schedule(p_sale_id, v_price, v_months, v_start);
    v_total := COALESCE(NULLIF((v_sched->>'total_repayable')::numeric, 0), NULLIF(v_sale.total_repayable, 0), v_price);
    v_daily := COALESCE(NULLIF((v_sched->>'first_daily')::numeric, 0), NULLIF(v_sale.access_daily_amount, 0), 0);
    v_days  := COALESCE(NULLIF((v_sched->>'days')::integer, 0), NULLIF(v_sale.access_repayment_days, 0), 365);
  END IF;

  SELECT full_name, phone INTO v_agent_name, v_agent_phone FROM public.profiles WHERE id = v_agent;
  SELECT full_name INTO v_supplier_name FROM public.profiles WHERE id = v_supplier;

  v_ref := 'smartphone-supplier-payment-' || p_sale_id::text;
  v_adv_ref := 'smartphone-advance-' || p_sale_id::text;

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_supplier, 'amount', v_price, 'direction', 'cash_in',
        'category', 'wallet_deposit', 'ledger_scope', 'wallet',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'merchandise_sales', 'source_id', p_sale_id,
        'reference_id', v_ref, 'currency', 'UGX',
        'description', 'Smartphone supplier payment for ' || COALESCE(v_agent_name, 'agent'),
        'transaction_date', now()
      ),
      -- 2026-11-04 (CFO): the phone is given to the agent on credit, so its cost is the receivable (A12), not an
      -- expense (X1). The supplier's wallet credit is unchanged.
      jsonb_build_object(
        'user_id', v_uid, 'amount', v_price, 'direction', 'cash_out',
        'category', 'smartphone_advance_receivable', 'ledger_scope', 'platform',
        'source_table', 'merchandise_sales', 'source_id', p_sale_id,
        'reference_id', v_ref, 'currency', 'UGX',
        'description', 'Smartphone receivable (A12): phone bought from ' || COALESCE(v_supplier_name, 'supplier')
                       || ' for ' || COALESCE(v_agent_name, 'agent'),
        'transaction_date', now()
      )
    ),
    v_ref
  );

  IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_adv_ref) THEN
    v_adv_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_agent, 'amount', v_price, 'direction', 'cash_in',
          'category', 'agent_advance_credit', 'ledger_scope', 'wallet',
          'recipient_type', 'user', 'wallet_bucket', 'advance_credit',
          'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_adv_ref, 'currency', 'UGX',
          'description', 'Smartphone advance recorded on wallet - '
                         || COALESCE(v_sale.item_name, 'Welile Smartphone'),
          'transaction_date', now()
        ),
        -- 2026-11-04 (CFO): the advance shown on the agent's wallet (advance_credit) is a display of what the agent owes,
        -- not money owed to the agent; offset it in L1. The receivable is recognised once, in the supplier group above.
        jsonb_build_object(
          'user_id', v_agent, 'amount', v_price, 'direction', 'cash_out',
          'category', 'merchandise_advance_memo_offset', 'ledger_scope', 'platform',
          'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_adv_ref, 'currency', 'UGX',
          'description', 'Offset of the smartphone advance shown on ' || COALESCE(v_agent_name, 'agent')
                         || '''s wallet (not money owed to the agent)',
          'transaction_date', now()
        )
      ),
      v_adv_ref
    );
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      payment_status = 'credit',
      payment_plan = CASE WHEN v_full THEN 'full' ELSE 'installment' END,
      advance_period_months = v_months,
      advance_markup_pct = CASE WHEN v_price > 0
                                THEN round((v_total - v_price) * 100 / v_price, 2)
                                ELSE advance_markup_pct END,
      total_repayable = v_total,
      access_daily_amount = v_daily,
      access_repayment_days = v_days,
      repayment_starts_on = v_start,
      payment_projection = v_total - v_price,
      amount_outstanding = v_total,
      supplier_id = v_supplier,
      cfo_disbursed_by = v_uid,
      cfo_disbursed_at = now(),
      disbursed_amount = v_price,
      disbursement_group_id = v_group,
      notes = COALESCE(notes, '') || ' | CFO paid supplier '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' amount ' || to_char(v_price, 'FM999,999,999')
              || CASE WHEN v_full THEN ' - full payment due'
                      ELSE ' - first daily ' || to_char(v_daily, 'FM999,999,999') END
              || ' from ' || to_char(v_start, 'YYYY-MM-DD')
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  SELECT id INTO v_plan_id
  FROM public.merchandise_recovery_plans
  WHERE sale_id = p_sale_id AND status = 'active'
  LIMIT 1;

  IF v_plan_id IS NULL THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, amount_recovered,
      daily_rate, daily_deduction_amount, starts_on, status, created_by
    ) VALUES (
      p_sale_id, v_agent, COALESCE(v_agent_name, v_sale.client_name),
      COALESCE(v_agent_phone, v_sale.client_phone),
      COALESCE(v_sale.item_name, 'Welile Smartphone'),
      v_total, v_total, 0,
      0.33, v_daily, v_start, 'active', v_uid
    ) RETURNING id INTO v_plan_id;
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET customer_id = v_agent,
        customer_name = COALESCE(v_agent_name, customer_name),
        customer_phone = COALESCE(v_agent_phone, customer_phone),
        original_amount = v_total,
        outstanding_balance = GREATEST(v_total - COALESCE(amount_recovered, 0), 0),
        daily_deduction_amount = v_daily,
        starts_on = COALESCE(starts_on, v_start),
        updated_at = now()
    WHERE id = v_plan_id;
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'smartphone_advance_disbursed', 'merchandise_sales', p_sale_id,
            'CFO paid the registered supplier; ID and workplace photo verified on collection day',
            jsonb_build_object('price', v_price, 'total_repayable', v_total,
                               'first_daily', v_daily, 'starts_on', v_start,
                               'schedule', v_sched,
                               'supplier_id', v_supplier, 'repaid_by_agent_id', v_agent,
                               'advance_group_id', v_adv_group,
                               'recovery_plan_id', v_plan_id));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id, 'order_status', 'approved',
    'total_amount', v_price, 'disbursed_amount', v_price,
    'payment_projection', v_total - v_price, 'daily_amount', v_daily,
    'repayment_starts_on', v_start, 'disbursement_group_id', v_group,
    'advance_group_id', v_adv_group, 'advance_recorded', v_price,
    'recovery_plan_id', v_plan_id, 'repaid_by_agent_id', v_agent,
    'paid_supplier_id', v_supplier, 'schedule', v_sched
  );
END;
$function$;

-- ---------------------------------------------------------------- 3. one-off: the 8 smartphone payouts (X1 / L1 double count)
-- Each payout booked the phone twice: DR X1 equipment_expense / CR the supplier's wallet (L1, real: the supplier was
-- paid) AND DR A12 / CR the agent's advance_credit wallet bucket (L1). The receivable (A12) is right; the expense (X1)
-- is not (the phone is a receivable, not a cost) and the agent's advance_credit is a display of what the agent owes,
-- not money owed to the agent (it is not withdrawable). One new balanced group per payout, platform legs only:
-- DR L1 merchandise_advance_memo_offset / CR X1 equipment_expense. Wallets, the advance shown to agents and A12 are
-- unchanged. Idempotent (key merch_phase3_20261104:<sale>:PHONE_MEMO).
DO $phone$
DECLARE r record; v_x1 uuid; v_memo uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('9b704619-2d97-44cb-a61e-5ba7ac6525f6'::uuid, 165000::numeric),
    ('8c6a5ae9-8b38-42cd-a8aa-486dc95a298e'::uuid, 165000::numeric),
    ('3d11c494-31b9-468a-a638-24921a83a0b5'::uuid, 700000::numeric),
    ('548c49eb-d62b-4901-a3dd-7f745377a469'::uuid, 1500000::numeric),
    ('85bce373-09ee-4d15-b130-8380e81fea0a'::uuid, 165000::numeric),
    ('0a128951-9353-47c3-b51a-203e257ab582'::uuid, 800000::numeric),
    ('561e4919-4a93-4961-a33f-5900d0f11276'::uuid, 800000::numeric),
    ('c60db3db-334d-453e-89b8-aa1557535778'::uuid, 950000::numeric)) v(sale, amt) LOOP
    SELECT transaction_group_id INTO v_x1 FROM public.general_ledger WHERE source_table = 'merchandise_sales' AND source_id = r.sale
      AND ledger_scope = 'platform' AND category = 'equipment_expense' AND direction = 'cash_out';
    SELECT transaction_group_id INTO v_memo FROM public.general_ledger WHERE source_table = 'merchandise_sales' AND source_id = r.sale
      AND ledger_scope = 'wallet' AND category = 'agent_advance_credit' AND wallet_bucket = 'advance_credit';
    PERFORM public.create_ledger_transaction(entries => jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amt, 'category', 'merchandise_advance_memo_offset',
        'source_table', 'merchandise_sales', 'source_id', r.sale, 'reference_id', v_memo::text, 'currency', 'UGX',
        'description', 'Correction 2026-11-04 (CFO): the smartphone advance shown on the agent''s wallet is not money owed to the agent (L1); offsets wallet memo group ' || v_memo::text),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amt, 'category', 'equipment_expense',
        'source_table', 'merchandise_sales', 'source_id', r.sale, 'reference_id', v_x1::text, 'currency', 'UGX',
        'description', 'Correction 2026-11-04 (CFO): smartphone cost is the A12 receivable, not an expense (X1); reverses supplier-payment group ' || v_x1::text)),
      idempotency_key => 'merch_phase3_20261104:' || r.sale::text || ':PHONE_MEMO');
  END LOOP;
END $phone$;

-- ---------------------------------------------------------------- 4. company-stock recognition

ALTER TABLE public.merchandise_accounting_controls
  ADD COLUMN stock_issue_counterpart text CHECK (stock_issue_counterpart IN ('revenue'));
COMMENT ON COLUMN public.merchandise_accounting_controls.stock_issue_counterpart IS
  'CFO decision 2026-11-04: ''revenue''. Company stock issued on credit is queued in merchandise_stock_recognitions; '
  'the receivable and the revenue (DR A12/A13 / CR R1 merchandise_revenue) are recognised automatically only when the '
  'handover is confirmed (handed_over_at and handed_over_by). NULL: every item waits for the CFO.';
UPDATE public.merchandise_accounting_controls SET stock_issue_counterpart = 'revenue', updated_at = now() WHERE id;

CREATE TABLE public.merchandise_stock_recognitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL UNIQUE,                  -- one row per order, ever
  plan_ids uuid[] NOT NULL DEFAULT '{}',
  item_name text, customer_id uuid, account text NOT NULL CHECK (account IN ('A12', 'A13')),
  origin text NOT NULL CHECK (origin IN ('historical_20261104', 'issue')),
  principal numeric NOT NULL,                    -- order total (price x quantity)
  amount_paid numeric NOT NULL DEFAULT 0,        -- customer payments on the order when queued / posted
  amount numeric NOT NULL,                       -- receivable to recognise: principal not yet paid or already recognised
  flags text[] NOT NULL DEFAULT '{}',            -- no_handover_record, unrecorded_payment, customer_payment_only,
                                                 -- outsourced_item_no_supplier_payout, historical
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'no_action')),
  counterpart text CHECK (counterpart IN ('revenue')),
  evidence_kind text CHECK (evidence_kind IN ('handover_record', 'cfo_verified_document')),
  delivery_evidence text,                        -- the handover note, or the document the CFO verified
  ledger_group_id uuid, idempotency_key text,
  decided_by uuid, decided_at timestamptz, decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.merchandise_stock_recognitions IS
  'Company stock issued to an agent on credit: the receivable and sales revenue to recognise once delivery is evidenced '
  '(handover record, or a delivery document the CFO verified). Written only by the merchandise controls (20261104150000).';
ALTER TABLE public.merchandise_stock_recognitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cfo_reads_merch_stock_recognitions ON public.merchandise_stock_recognitions FOR SELECT TO authenticated
  USING ((select public.has_role((select auth.uid()), 'cfo'::app_role)) OR (select public.has_role((select auth.uid()), 'ceo'::app_role))
      OR (select public.has_role((select auth.uid()), 'coo'::app_role)) OR (select public.has_role((select auth.uid()), 'super_admin'::app_role)));
create policy mfa_required_for_staff on public.merchandise_stock_recognitions as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
REVOKE ALL ON public.merchandise_stock_recognitions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.merchandise_stock_recognitions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_stock_recognitions TO service_role;

-- The receivable still to recognise for an order: principal - payments not yet recorded against it - what A12/A13
-- already carries. Payments recorded against the order (principal credits already in A12/A13, charges in R1) were
-- taken off a receivable that is only now recognised, so they are added back; a down payment recorded as
-- merchandise_revenue is already income and is not added back; a payment never recorded in the ledger is not owed.
CREATE OR REPLACE FUNCTION public._merch_stock_receivable_due(p_sale uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE s record; v_plans uuid[]; v_bike boolean; v_net jsonb; v_rec numeric; v_charges numeric; v_due numeric;
BEGIN
  SELECT * INTO s FROM public.merchandise_sales WHERE id = p_sale;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(array_agg(p.id), '{}') INTO v_plans FROM public.merchandise_recovery_plans p WHERE p.sale_id = p_sale;
  v_bike := public.agent_product_category(s.item_name) = 'motor_bike';
  v_net := public._merch_receivable_net(p_sale, v_plans, v_bike);
  -- charges recorded against the order (R1) and all customer cash recorded against it
  SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END)
                    FILTER (WHERE g.category = 'access_fee_collected'), 0),
         COALESCE(sum(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END)
                    FILTER (WHERE g.ledger_scope = 'wallet' AND g.category IN ('agent_repayment', 'system_balance_correction')), 0)
    INTO v_charges, v_rec
  FROM public.general_ledger g
  WHERE (g.source_table = 'merchandise_sales' AND g.source_id = p_sale)
     OR (g.source_table = 'merchandise_recovery_plans' AND g.source_id = ANY (v_plans));
  v_due := COALESCE(s.total_revenue, 0) - COALESCE(s.amount_paid, 0) + v_charges
           - (CASE WHEN v_bike THEN (v_net->>'a13')::numeric ELSE (v_net->>'a12')::numeric END);
  RETURN jsonb_build_object('due', GREATEST(round(v_due, 2), 0), 'account', CASE WHEN v_bike THEN 'A13' ELSE 'A12' END,
    'principal', COALESCE(s.total_revenue, 0), 'amount_paid', COALESCE(s.amount_paid, 0), 'cash_recorded', v_rec,
    'charges_recorded', v_charges, 'receivable_now', CASE WHEN v_bike THEN v_net->'a13' ELSE v_net->'a12' END, 'plans', to_jsonb(v_plans),
    'unrecorded_payment', GREATEST(COALESCE(s.amount_paid, 0) - v_rec, 0));
END $function$;

CREATE OR REPLACE FUNCTION public._merch_stock_queue(p_sale uuid, p_origin text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE s record; v jsonb; v_id uuid; v_flags text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM public.merchandise_stock_recognitions WHERE sale_id = p_sale) THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.merchandise_sales WHERE id = p_sale;
  v := public._merch_stock_receivable_due(p_sale);
  IF v IS NULL OR (v->>'due')::numeric <= 0 THEN RETURN NULL; END IF;
  IF s.handed_over_at IS NULL OR s.handed_over_by IS NULL THEN v_flags := v_flags || 'no_handover_record'::text; END IF;
  IF (v->>'unrecorded_payment')::numeric > 0 THEN v_flags := v_flags || 'unrecorded_payment'::text; END IF;
  -- a customer payment is not delivery evidence (customers also pay on undelivered orders)
  IF s.handed_over_at IS NULL AND (COALESCE(s.amount_paid, 0) > 0 OR (v->>'cash_recorded')::numeric > 0) THEN
    v_flags := v_flags || 'customer_payment_only'::text;
  END IF;
  -- an item the catalog fulfils through a supplier, issued with no supplier payout: probably never delivered
  IF EXISTS (SELECT 1 FROM public.merchandise_catalog c WHERE lower(c.item_name) = lower(s.item_name) AND c.fulfilment_type = 'outsourced') THEN
    v_flags := v_flags || 'outsourced_item_no_supplier_payout'::text;
  END IF;
  IF p_origin = 'historical_20261104' THEN v_flags := v_flags || 'historical'::text; END IF;
  INSERT INTO public.merchandise_stock_recognitions (sale_id, plan_ids, item_name, customer_id, account, origin, principal,
    amount_paid, amount, flags)
  VALUES (p_sale, ARRAY(SELECT jsonb_array_elements_text(v->'plans'))::uuid[], s.item_name, s.customer_id, v->>'account', p_origin,
    (v->>'principal')::numeric, (v->>'amount_paid')::numeric, (v->>'due')::numeric, v_flags)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 'merchandise_stock_issue_queued', 'merchandise_stock_recognitions', v_id::text, p_origin,
          jsonb_build_object('sale_id', p_sale, 'due', v));
  RETURN v_id;
END $function$;

CREATE OR REPLACE FUNCTION public._merch_post_stock_recognition(p_review uuid, p_evidence_kind text, p_evidence text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; s record; v jsonb; v_amt numeric; v_key text; v_group uuid; v_desc text; v_entries jsonb;
  p_counterpart constant text := 'revenue'; p_note text;
BEGIN
  IF p_evidence_kind IS NULL OR p_evidence_kind NOT IN ('handover_record', 'cfo_verified_document') THEN
    RAISE EXCEPTION 'delivery evidence kind must be handover_record or cfo_verified_document';
  END IF;
  SELECT * INTO r FROM public.merchandise_stock_recognitions WHERE id = p_review FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock recognition % not found', p_review; END IF;
  IF r.status <> 'pending' THEN
    RETURN jsonb_build_object('id', r.id, 'status', r.status, 'ledger_group_id', r.ledger_group_id, 'already', true);
  END IF;
  SELECT * INTO s FROM public.merchandise_sales WHERE id = r.sale_id;
  IF p_evidence_kind = 'handover_record' AND (s.handed_over_at IS NULL OR s.handed_over_by IS NULL) THEN
    RAISE EXCEPTION 'no handover record on order %: recognise only on verified delivery evidence', r.sale_id;
  END IF;
  IF p_evidence_kind = 'cfo_verified_document' AND length(btrim(COALESCE(p_evidence, ''))) < 20 THEN
    RAISE EXCEPTION 'name the delivery document verified (at least 20 characters)';
  END IF;
  p_note := p_evidence_kind || ': ' || COALESCE(btrim(p_evidence), '');
  -- recomputed now: what was paid or recognised since it was queued is taken into account; an order that is no longer
  -- issued (rejected / cancelled / failed / deleted) recognises nothing (the derecognition controls cover what is left)
  v := public._merch_stock_receivable_due(r.sale_id);
  v_amt := CASE WHEN s.id IS NULL OR s.order_status NOT IN ('issued', 'completed', 'approved') THEN 0
                ELSE COALESCE((v->>'due')::numeric, 0) END;
  v_key := 'merch_stock_recog:' || r.id::text;
  IF v_amt > 0 THEN
    v_desc := 'Company stock issued on credit: ' || COALESCE(r.item_name, 'merchandise') || ' - receivable ' || r.account
              || ' / sales revenue (R1)'
              || ' - ' || COALESCE(p_note, '');
      v_entries := jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_amt,
          'category', CASE r.account WHEN 'A13' THEN 'bike_recovery_repayment' ELSE 'smartphone_advance_receivable' END,
          'source_table', 'merchandise_sales', 'source_id', r.sale_id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_amt, 'category', 'merchandise_revenue',
          'source_table', 'merchandise_sales', 'source_id', r.sale_id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc));
    v_group := public.create_ledger_transaction(entries => v_entries, idempotency_key => v_key);
  END IF;
  UPDATE public.merchandise_stock_recognitions
  SET status = CASE WHEN v_group IS NULL THEN 'no_action' ELSE 'posted' END,
      counterpart = CASE WHEN v_group IS NULL THEN NULL ELSE p_counterpart END,
      amount = v_amt, amount_paid = COALESCE((v->>'amount_paid')::numeric, amount_paid),
      ledger_group_id = v_group, idempotency_key = CASE WHEN v_group IS NULL THEN NULL ELSE v_key END,
      evidence_kind = p_evidence_kind, delivery_evidence = btrim(p_evidence),
      decided_by = p_actor, decided_at = now(), decision_note = p_note, updated_at = now()
  WHERE id = r.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (p_actor, 'merchandise_stock_recognised', 'merchandise_stock_recognitions', r.id::text, p_note,
          jsonb_build_object('sale_id', r.sale_id, 'counterpart', p_counterpart, 'amount', v_amt, 'ledger_group_id', v_group,
                             'idempotency_key', v_key, 'due', v));
  RETURN jsonb_build_object('id', r.id, 'status', CASE WHEN v_group IS NULL THEN 'no_action' ELSE 'posted' END,
    'ledger_group_id', v_group, 'amount', v_amt, 'counterpart', p_counterpart);
END $function$;

CREATE OR REPLACE FUNCTION public.cfo_post_merchandise_stock_recognition(p_review_id uuid, p_delivery_evidence text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_sale uuid; v_handed boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'cfo'::app_role) OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Only the CFO can recognise a company-stock receivable';
  END IF;
  SELECT r.sale_id, (s.handed_over_at IS NOT NULL AND s.handed_over_by IS NOT NULL) INTO v_sale, v_handed
  FROM public.merchandise_stock_recognitions r LEFT JOIN public.merchandise_sales s ON s.id = r.sale_id WHERE r.id = p_review_id;
  IF v_sale IS NULL THEN RAISE EXCEPTION 'stock recognition % not found', p_review_id; END IF;
  -- sales revenue only (CFO decision 2026-11-04), and only on verified delivery evidence
  IF v_handed THEN
    RETURN public._merch_post_stock_recognition(p_review_id, 'handover_record', COALESCE(NULLIF(btrim(p_delivery_evidence), ''), 'handover record'), auth.uid());
  END IF;
  IF length(btrim(COALESCE(p_delivery_evidence, ''))) < 20 THEN
    RAISE EXCEPTION 'No handover record: name the delivery document you verified (at least 20 characters), or leave the item in the queue';
  END IF;
  RETURN public._merch_post_stock_recognition(p_review_id, 'cfo_verified_document', btrim(p_delivery_evidence), auth.uid());
END $function$;

-- Every path that puts company stock in an agent's hands on credit with no payout behind it: handover
-- (confirm_merchandise_handover -> issued), Agent Ops approval of a non-boutique order (-> issued), an Agent Ops issue
-- (agent_ops_issue_agent_product: inserted as approved, channel agent_ops) and completion. Orders with a CFO payout
-- (bike, smartphone, out-sourced) open their receivable at payout and are excluded.
CREATE OR REPLACE FUNCTION public._merch_stock_on_handover(p_sale uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- A confirmed handover is the delivery evidence: queue the order if it is not queued yet, and recognise the receivable
-- and the revenue once, in the handover's own transaction, when the CFO's standing choice is 'revenue'.
DECLARE s record; v_id uuid; v_auto text;
BEGIN
  SELECT * INTO s FROM public.merchandise_sales WHERE id = p_sale;
  IF NOT FOUND OR s.handed_over_at IS NULL OR s.handed_over_by IS NULL THEN RETURN; END IF;
  IF s.cfo_disbursed_at IS NOT NULL OR s.disbursement_group_id IS NOT NULL OR s.customer_id IS NULL THEN RETURN; END IF;
  PERFORM public._merch_stock_queue(p_sale, 'issue');
  SELECT id INTO v_id FROM public.merchandise_stock_recognitions WHERE sale_id = p_sale AND status = 'pending';
  SELECT stock_issue_counterpart INTO v_auto FROM public.merchandise_accounting_controls WHERE id;
  IF v_id IS NOT NULL AND v_auto = 'revenue' THEN
    PERFORM public._merch_post_stock_recognition(v_id, 'handover_record',
      COALESCE(NULLIF(btrim(s.handover_note), ''), 'handover confirmed ' || to_char(s.handed_over_at, 'YYYY-MM-DD')), s.handed_over_by);
  END IF;
END $function$;

-- Every path that puts company stock in an agent's hands on credit with no payout behind it is QUEUED (handover ->
-- issued, Agent Ops approval of a non-boutique order -> issued, an Agent Ops issue, completion). Recognition needs
-- delivery evidence: the handover confirmation (here, automatic) or a CFO-verified delivery document (RPC).
-- Orders with a CFO payout (bike, smartphone, out-sourced) open their receivable at payout and are excluded.
CREATE OR REPLACE FUNCTION public.trg_merch_stock_issue_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.cfo_disbursed_at IS NOT NULL OR NEW.disbursement_group_id IS NOT NULL OR NEW.customer_id IS NULL THEN RETURN NULL; END IF;
  IF (NEW.order_status IN ('issued', 'completed') OR (NEW.order_status = 'approved' AND NEW.issued_channel = 'agent_ops'))
     AND NOT (TG_OP = 'UPDATE' AND (OLD.order_status IN ('issued', 'completed')
                                    OR (OLD.order_status = 'approved' AND OLD.issued_channel = 'agent_ops'))) THEN
    PERFORM public._merch_stock_queue(NEW.id, 'issue');
  END IF;
  IF NEW.handed_over_at IS NOT NULL AND NEW.handed_over_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.handed_over_at IS NULL OR OLD.handed_over_by IS NULL) THEN
    PERFORM public._merch_stock_on_handover(NEW.id);
  END IF;
  RETURN NULL;
END $function$;
CREATE TRIGGER trg_merch_stock_issue_insert AFTER INSERT ON public.merchandise_sales
  FOR EACH ROW EXECUTE FUNCTION public.trg_merch_stock_issue_event();
CREATE TRIGGER trg_merch_stock_issue_status AFTER UPDATE OF order_status, handed_over_at, handed_over_by ON public.merchandise_sales
  FOR EACH ROW WHEN (OLD.order_status IS DISTINCT FROM NEW.order_status OR OLD.handed_over_at IS DISTINCT FROM NEW.handed_over_at
                     OR OLD.handed_over_by IS DISTINCT FROM NEW.handed_over_by)
  EXECUTE FUNCTION public.trg_merch_stock_issue_event();

REVOKE ALL ON FUNCTION public._merch_stock_receivable_due(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_stock_queue(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_post_stock_recognition(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_stock_on_handover(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_merch_stock_issue_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cfo_post_merchandise_stock_recognition(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_post_merchandise_stock_recognition(uuid, text) TO authenticated;

-- ---------------------------------------------------------------- 4b. rejected motorcycle plans: payments retained (CFO policy)
ALTER TABLE public.merchandise_receivable_derecognitions DROP CONSTRAINT merchandise_receivable_derecognitions_counterpart_check;
ALTER TABLE public.merchandise_receivable_derecognitions ADD CONSTRAINT merchandise_receivable_derecognitions_counterpart_check
  CHECK (counterpart IN ('E3', 'X4', 'retained'));
COMMENT ON COLUMN public.merchandise_receivable_derecognitions.flags IS
  'receivable_open, credit_balance, possible_refund (non-motorcycle cash collected, review), retained_payment (motorcycle '
  'plan: cash kept by the company, CFO policy 2026-11-04, no refund), deleted';
CREATE OR REPLACE FUNCTION public._merch_receivable_event(p_sale uuid, p_plan uuid, p_event text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_subject uuid := COALESCE(p_sale, p_plan); v_plans uuid[]; v_item text; v_customer uuid; v_bike boolean;
  v_net jsonb; v_a12 numeric; v_a13 numeric; v_cash numeric; v_row record; v_flags text[]; v_auto text; v_id uuid;
  v_ev jsonb;
BEGIN
  IF v_subject IS NULL THEN RETURN; END IF;
  SELECT COALESCE(array_agg(p.id), '{}') INTO v_plans FROM public.merchandise_recovery_plans p
  WHERE (p_sale IS NOT NULL AND p.sale_id = p_sale) OR p.id = p_plan;
  IF p_plan IS NOT NULL AND NOT p_plan = ANY (v_plans) THEN v_plans := v_plans || p_plan; END IF;
  SELECT s.item_name, s.customer_id INTO v_item, v_customer FROM public.merchandise_sales s WHERE s.id = p_sale;
  IF v_item IS NULL THEN
    SELECT p.item_name, p.customer_id INTO v_item, v_customer FROM public.merchandise_recovery_plans p
    WHERE p.id = ANY (v_plans) ORDER BY p.created_at LIMIT 1;
  END IF;
  -- bike or not exactly as the balance-sheet resolver decides it (agent_product_category of the plan's item)
  v_bike := EXISTS (SELECT 1 FROM public.merchandise_recovery_plans p WHERE p.id = ANY (v_plans)
                    AND public.agent_product_category(p.item_name) = 'motor_bike');
  SELECT * INTO v_row FROM public.merchandise_receivable_derecognitions
  WHERE subject_id = v_subject AND status = 'pending' FOR UPDATE;
  IF FOUND THEN
    SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_plans FROM unnest(v_row.plan_ids || v_plans) x;
  END IF;
  v_net := public._merch_receivable_net(p_sale, v_plans, v_bike);
  v_a12 := (v_net->>'a12')::numeric; v_a13 := (v_net->>'a13')::numeric; v_cash := (v_net->>'cash')::numeric;
  IF v_row.id IS NULL AND v_a12 = 0 AND v_a13 = 0 AND v_cash <= 0 THEN RETURN; END IF;
  v_flags := '{}';
  IF v_a12 <> 0 OR v_a13 <> 0 THEN v_flags := v_flags || 'receivable_open'::text; END IF;
  IF v_a12 < 0 OR v_a13 < 0 THEN v_flags := v_flags || 'credit_balance'::text; END IF;
  -- CFO policy 2026-11-04: a rejected / cancelled motorcycle plan ends and the customer is not refunded; the cash
  -- collected is retained by the company. Other merchandise keeps the possible_refund flag for review.
  IF v_cash > 0 THEN
    v_flags := v_flags || CASE WHEN v_bike THEN 'retained_payment' ELSE 'possible_refund' END;
  END IF;
  IF p_event LIKE '%deleted' THEN v_flags := v_flags || 'deleted'::text; END IF;
  v_ev := jsonb_build_object('event', p_event, 'at', now(), 'by', auth.uid());
  IF v_row.id IS NULL THEN
    INSERT INTO public.merchandise_receivable_derecognitions (subject_id, sale_id, plan_ids, item_name, customer_id, is_bike,
      events, a12_net, a13_net, cash_collected_net, flags)
    VALUES (v_subject, p_sale, v_plans, v_item, v_customer, COALESCE(v_bike, false), jsonb_build_array(v_ev),
      v_a12, v_a13, v_cash, v_flags)
    RETURNING id INTO v_id;
  ELSE
    v_id := v_row.id;
    UPDATE public.merchandise_receivable_derecognitions
    SET plan_ids = v_plans, events = events || v_ev, a12_net = v_a12, a13_net = v_a13, cash_collected_net = v_cash,
        -- flags describe the subject now; 'deleted' is kept once seen
        flags = ARRAY(SELECT DISTINCT f FROM unnest(v_flags || CASE WHEN 'deleted' = ANY (flags) THEN ARRAY['deleted'] ELSE '{}'::text[] END) f ORDER BY 1),
        is_bike = is_bike OR COALESCE(v_bike, false), updated_at = now()
    WHERE id = v_id;
  END IF;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 'merchandise_receivable_event', 'merchandise_receivable_derecognitions', v_id::text, p_event,
          jsonb_build_object('subject_id', v_subject, 'sale_id', p_sale, 'plan_id', p_plan, 'a12', v_a12, 'a13', v_a13,
                             'cash_collected_net', v_cash, 'flags', v_flags));
  SELECT auto_derecognition_counterpart INTO v_auto FROM public.merchandise_accounting_controls WHERE id;
  IF v_auto IS NOT NULL AND (v_a12 <> 0 OR v_a13 <> 0) THEN
    PERFORM public._merch_post_derecognition(v_id, v_auto, 'automatic: ' || p_event, auth.uid());
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public._merch_post_derecognition(p_review uuid, p_counterpart text, p_note text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_plans uuid[]; v_net jsonb; v_entries jsonb := '[]'::jsonb; v_key text; v_group uuid;
  v_acct text; v_amt numeric; v_src_table text; v_src uuid; v_desc text;
BEGIN
  IF p_counterpart NOT IN ('E3', 'X4', 'retained') THEN RAISE EXCEPTION 'counterpart must be E3, X4 or retained'; END IF;
  SELECT * INTO r FROM public.merchandise_receivable_derecognitions WHERE id = p_review FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'derecognition % not found', p_review; END IF;
  IF r.status <> 'pending' THEN
    RETURN jsonb_build_object('id', r.id, 'status', r.status, 'ledger_group_id', r.ledger_group_id, 'already', true);
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_plans
  FROM unnest(r.plan_ids || COALESCE((SELECT array_agg(p.id) FROM public.merchandise_recovery_plans p WHERE p.sale_id = r.sale_id), '{}')) x;
  v_net := public._merch_receivable_net(r.sale_id, v_plans, r.is_bike);
  v_src_table := CASE WHEN r.sale_id IS NOT NULL THEN 'merchandise_sales' ELSE 'merchandise_recovery_plans' END;
  v_src := COALESCE(r.sale_id, r.subject_id);
  v_key := 'merch_recv_derecog:' || r.id::text;
  FOREACH v_acct IN ARRAY ARRAY['A12', 'A13'] LOOP
    v_amt := (v_net->>lower(v_acct))::numeric;
    CONTINUE WHEN v_amt = 0;
    -- 'retained' (CFO policy 2026-11-04): only a motorcycle plan's credit balance, i.e. customer cash collected on a
    -- receivable that is gone, recognised as retained-payment income (DR A13 / CR R1). A receivable still open is
    -- derecognised with E3 or X4, never as income.
    IF p_counterpart = 'retained' AND NOT (r.is_bike AND v_acct = 'A13' AND v_amt < 0) THEN
      RAISE EXCEPTION 'retained applies only to a motorcycle plan''s credit balance (cash collected); % is %', v_acct, v_amt;
    END IF;
    v_desc := 'Receivable derecognised (' || v_acct || ', CFO ' || CASE p_counterpart WHEN 'E3' THEN 'restatement' WHEN 'retained' THEN 'payments retained, rejected motorcycle plan' ELSE 'write-off' END
              || '): ' || COALESCE(r.item_name, 'merchandise') || ' - ' || COALESCE(p_note, '');
    -- a positive balance is removed with a credit to the receivable; a credit balance with a debit
    IF p_counterpart = 'retained' THEN
      v_entries := v_entries || jsonb_build_array(
        jsonb_build_object('ledger_scope', 'bridge', 'category', 'bike_recovery_receivable_opening', 'direction', 'cash_in', 'amount', abs(v_amt),
          'source_table', v_src_table, 'source_id', v_src, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc),
        jsonb_build_object('ledger_scope', 'platform', 'category', 'merchandise_payment_retained', 'direction', 'cash_out', 'amount', abs(v_amt),
          'source_table', v_src_table, 'source_id', v_src, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc));
    ELSIF p_counterpart = 'E3' THEN
      v_entries := v_entries || jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'category', 'receivable_restatement_equity',
          'direction', CASE WHEN v_amt > 0 THEN 'cash_in' ELSE 'cash_out' END, 'amount', abs(v_amt),
          'source_table', v_src_table, 'source_id', v_src, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc),
        jsonb_build_object('ledger_scope', 'bridge',
          'category', CASE v_acct WHEN 'A12' THEN 'merchandise_recovery_receivable_opening' ELSE 'bike_recovery_receivable_opening' END,
          'direction', CASE WHEN v_amt > 0 THEN 'cash_out' ELSE 'cash_in' END, 'amount', abs(v_amt),
          'source_table', v_src_table, 'source_id', v_src, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc));
    ELSE
      v_entries := v_entries || jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'category', 'platform_loss_writeoff',
          'direction', CASE WHEN v_amt > 0 THEN 'cash_out' ELSE 'cash_in' END, 'amount', abs(v_amt),
          'source_table', v_src_table, 'source_id', v_src, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc),
        jsonb_build_object('ledger_scope', 'platform',
          'category', CASE v_acct WHEN 'A12' THEN 'merchandise_recovery_repayment' ELSE 'bike_recovery_repayment' END,
          'direction', CASE WHEN v_amt > 0 THEN 'cash_in' ELSE 'cash_out' END, 'amount', abs(v_amt),
          'source_table', v_src_table, 'source_id', v_src, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_entries) > 0 THEN
    v_group := public.create_ledger_transaction(entries => v_entries, idempotency_key => v_key);
  END IF;
  UPDATE public.merchandise_receivable_derecognitions
  SET status = CASE WHEN v_group IS NULL THEN 'no_action' ELSE 'posted' END,
      counterpart = CASE WHEN v_group IS NULL THEN NULL ELSE p_counterpart END,
      a12_net = (v_net->>'a12')::numeric, a13_net = (v_net->>'a13')::numeric,
      ledger_group_id = v_group, idempotency_key = CASE WHEN v_group IS NULL THEN NULL ELSE v_key END,
      decided_by = p_actor, decided_at = now(), decision_note = p_note, updated_at = now()
  WHERE id = r.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (p_actor, 'merchandise_receivable_derecognised', 'merchandise_receivable_derecognitions', r.id::text, p_note,
          jsonb_build_object('subject_id', r.subject_id, 'sale_id', r.sale_id, 'plan_ids', v_plans, 'counterpart', p_counterpart,
                             'a12', v_net->'a12', 'a13', v_net->'a13', 'ledger_group_id', v_group, 'idempotency_key', v_key));
  RETURN jsonb_build_object('id', r.id, 'status', CASE WHEN v_group IS NULL THEN 'no_action' ELSE 'posted' END,
    'ledger_group_id', v_group, 'a12', v_net->'a12', 'a13', v_net->'a13', 'counterpart', p_counterpart);
END $function$;

CREATE OR REPLACE FUNCTION public.cfo_post_merchandise_derecognition(p_review_id uuid, p_counterpart text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'cfo'::app_role) OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Only the CFO can derecognise a merchandise receivable';
  END IF;
  IF p_counterpart IS NULL OR p_counterpart NOT IN ('E3', 'X4', 'retained') THEN
    RAISE EXCEPTION 'Choose E3 (receivable that should not have been recognised), X4 (write-off) or retained (payments kept on a rejected motorcycle plan)';
  END IF;
  IF length(btrim(COALESCE(p_note, ''))) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters';
  END IF;
  RETURN public._merch_post_derecognition(p_review_id, p_counterpart, btrim(p_note), auth.uid());
END $function$;

-- ---------------------------------------------------------------- 5. monthly Returns pledge: eligible orders only
CREATE OR REPLACE FUNCTION public.apply_smartphone_roi_pledge(p_user_id uuid, p_roi_amount numeric, p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_p record; v_plan record; v_pledged numeric; v_avail numeric; v_amount numeric; v_closing numeric;
  v_split jsonb; v_prin_part numeric; v_charge_part numeric; v_entries jsonb;
  v_skip uuid; v_why text;
BEGIN
  IF COALESCE(p_roi_amount,0) <= 0 THEN RETURN jsonb_build_object('applied',0,'reason','no_roi'); END IF;
  IF EXISTS (SELECT 1 FROM public.smartphone_roi_pledge_applications WHERE reference = p_reference) THEN
    RETURN jsonb_build_object('applied',0,'reason','already_applied');
  END IF;
  SELECT * INTO v_p FROM public.smartphone_roi_pledges WHERE user_id = p_user_id AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',0,'reason','no_pledge'); END IF;
  -- 2026-11-04 (CFO): collect only on an order that is approved and delivered (the same gate as every other
  -- collection path: merchandise_plan_recovery_eligible). An ineligible order is skipped and recorded; the Returns
  -- payout itself is never affected (this function does not raise for it).
  SELECT p.* INTO v_plan FROM public.merchandise_recovery_plans p
    JOIN public.merchandise_sales s ON s.id = p.sale_id
    WHERE p.customer_id = p_user_id AND p.status = 'active' AND p.outstanding_balance > 0
      AND NOT COALESCE(p.is_bike_lease,false) AND s.item_name ILIKE '%smartphone%'
      AND public.merchandise_plan_recovery_eligible(p.id)
    ORDER BY p.created_at LIMIT 1 FOR UPDATE OF p;
  IF NOT FOUND THEN
    SELECT p.id INTO v_skip FROM public.merchandise_recovery_plans p
      JOIN public.merchandise_sales s ON s.id = p.sale_id
      WHERE p.customer_id = p_user_id AND p.status = 'active' AND p.outstanding_balance > 0
        AND NOT COALESCE(p.is_bike_lease,false) AND s.item_name ILIKE '%smartphone%'
      ORDER BY p.created_at LIMIT 1;
    IF v_skip IS NULL THEN RETURN jsonb_build_object('applied',0,'reason','no_plan'); END IF;
    v_why := public.merchandise_plan_ineligible_reason(v_skip);
    BEGIN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      VALUES (p_user_id, 'smartphone_pledge_skipped_ineligible', 'merchandise_recovery_plans', v_skip::text, v_why,
              jsonb_build_object('reference', p_reference, 'roi_amount', p_roi_amount));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('applied',0,'reason','order_not_eligible','plan_id',v_skip,'detail',v_why);
  END IF;
  v_pledged := CASE WHEN v_p.mode = 'percent' THEN floor(p_roi_amount * v_p.value / 100) ELSE v_p.value END;
  v_avail := COALESCE(public.get_user_available_balance(p_user_id),0);
  v_amount := floor(LEAST(v_pledged, p_roi_amount, v_plan.outstanding_balance, v_avail));
  IF v_amount <= 0 THEN RETURN jsonb_build_object('applied',0,'reason','nothing_available'); END IF;

  -- 2026-11-03 (CFO): principal -> A12 (merchandise_recovery_repayment), charge -> R1 (access_fee_collected);
  -- was one A10 leg (agent_advance_repayment). The wallet leg is unchanged.
  v_split := public._smartphone_recovery_split_safe(v_plan.id, v_amount, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_prin_part := (v_split->>'principal')::numeric;
  v_charge_part := (v_split->>'charge')::numeric;
  v_entries := jsonb_build_array(
    jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
      'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone repayment - ' || COALESCE(v_plan.item_name,'Welile Smartphone') || ' (from monthly Returns)'));
  IF v_prin_part > 0 THEN
    v_entries := v_entries || jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
      'amount', v_prin_part, 'category', 'merchandise_recovery_repayment', 'recipient_type', 'operational_wallet',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone cost recovered from monthly Returns: ' || COALESCE(v_plan.item_name,'Welile Smartphone'));
  END IF;
  IF v_charge_part > 0 THEN
    v_entries := v_entries || jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
      'amount', v_charge_part, 'category', 'access_fee_collected', 'recipient_type', 'operational_wallet',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone monthly charge collected from monthly Returns: ' || COALESCE(v_plan.item_name,'Welile Smartphone'));
  END IF;
  PERFORM public.create_ledger_transaction(entries => v_entries, idempotency_key => 'phone_roi_pledge_' || p_reference);

  v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);
  INSERT INTO public.merchandise_recovery_deductions (plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref)
    VALUES (v_plan.id, p_user_id, COALESCE(v_plan.item_name,'Welile Smartphone') || ' (from monthly Returns)', v_amount, v_avail, v_closing, gen_random_uuid());
  UPDATE public.merchandise_recovery_plans
    SET outstanding_balance = v_closing, amount_recovered = amount_recovered + v_amount,
        due_balance = GREATEST(0, COALESCE(due_balance,0) - v_amount), last_recovery_at = now(),
        status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
        completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END, updated_at = now()
    WHERE id = v_plan.id;
  UPDATE public.merchandise_sales
    SET amount_paid = COALESCE(amount_paid,0) + v_amount,
        amount_outstanding = GREATEST(0, COALESCE(amount_outstanding,0) - v_amount), updated_at = now()
    WHERE id = v_plan.sale_id;
  INSERT INTO public.smartphone_roi_pledge_applications(user_id, plan_id, reference, roi_amount, pledged_amount, applied_amount, outstanding_after)
    VALUES (p_user_id, v_plan.id, p_reference, p_roi_amount, v_pledged, v_amount, v_closing);
  BEGIN
    INSERT INTO public.system_events(event_type, user_id, metadata)
    VALUES ('payment_made', p_user_id, jsonb_build_object('kind','smartphone_roi_pledge_applied','amount',v_amount,'plan_id',v_plan.id,'reference',p_reference));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('applied', v_amount, 'outstanding_after', v_closing);
END $function$;

-- ---------------------------------------------------------------- 6. CFO review rows (no ledger posting)
-- 6a. the 7 company-stock items issued 24-25 Sep with nothing posted: queued, NOT posted - none has a handover record,
--     a customer acceptance or a delivery document (verified read-only 2026-11-04). Each is recognised as sales revenue
--     only when a handover is confirmed or the CFO records a verified delivery document.
SELECT public._merch_stock_queue(v.sale, 'historical_20261104') FROM (VALUES
    ('cdd33740-b2ee-47ab-b49d-1c7a4e23db7b'::uuid, 55000::numeric),
    ('9a8b2824-1241-40a1-b2ec-77519a66d2d4'::uuid, 55000::numeric),
    ('d99c3173-a6c9-4168-af94-02e695cb398c'::uuid, 55000::numeric),
    ('ded6710e-1a30-4f17-9f24-463de40081d4'::uuid, 55000::numeric),
    ('bf40085c-dedc-44ef-9e38-d6170a57209a'::uuid, 650000::numeric),
    ('4cf491c5-21b0-4366-9369-7a210b431013'::uuid, 110000::numeric),
    ('882c5336-b5b0-4108-bbc3-11b004dde5c3'::uuid, 35000::numeric)) v(sale, amt);
-- 6b. the two motorcycle plans rejected on 6 Oct (CFO policy: no refund; payments retained). After the 22 Sep restatement
--     (DR A13 / CR E3: 120,000 and 665,000) and J5 (DR E3 / CR A13: 10,549 and 664,896.52) the cash collected sits as
--     a credit in E3: 109,451 (13 deductions 2-6 Aug) and 103.48 (24 Sep). It became the company's at rejection (6 Oct),
--     so it is income now: DR E3 receivable_restatement_equity / CR R1 merchandise_payment_retained. Platform legs only;
--     no refund, no wallet change; the original payments and entries stay. Idempotent (key ...:<sale>:RETAINED).
DO $retained$
DECLARE r record; v_group uuid; v_id uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('dddc2333-efb2-4855-9ab7-f3d5c3793873'::uuid, '08f711e2-927a-43dd-bce0-73831c4dd16a'::uuid, 109451::numeric, 'Martin Lukwago, 13 wallet deductions 2-6 Aug 2026'),
    ('54c4c664-6004-4aab-a56c-b285050633cd'::uuid, '9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0'::uuid, 103.48::numeric, 'Peter Bukoma, payment 24 Sep 2026')) v(sale, plan, amt, who) LOOP
    v_group := public.create_ledger_transaction(entries => jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amt, 'category', 'receivable_restatement_equity',
        'source_table', 'merchandise_recovery_plans', 'source_id', r.plan, 'reference_id', r.sale::text, 'currency', 'UGX',
        'description', 'Correction 2026-11-04 (CFO policy): motorcycle plan rejected 6 Oct; customer payments retained (' || r.who || '); moved from E3 to income'),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amt, 'category', 'merchandise_payment_retained',
        'source_table', 'merchandise_recovery_plans', 'source_id', r.plan, 'reference_id', r.sale::text, 'currency', 'UGX',
        'description', 'Payments retained on rejected motorcycle plan (no refund, CFO policy 2026-11-04): ' || r.who)),
      idempotency_key => 'merch_phase3_20261104:' || r.sale::text || ':RETAINED');
    -- the review row records the policy: retained_payment, not a refund; nothing left to derecognise
    PERFORM public._merch_receivable_event(r.sale, NULL, 'historical_review_20261104: motorcycle plan rejected 2026-10-06; payments retained (CFO policy, no refund)');
    SELECT id INTO v_id FROM public.merchandise_receivable_derecognitions WHERE sale_id = r.sale AND status = 'pending';
    UPDATE public.merchandise_receivable_derecognitions
    SET status = 'no_action', counterpart = 'retained', ledger_group_id = v_group,
        idempotency_key = 'merch_phase3_20261104:' || r.sale::text || ':RETAINED',
        decided_at = now(), updated_at = now(),
        decision_note = 'CFO policy 2026-11-04: a rejected motorcycle plan ends without a refund; the ' || r.amt
          || ' collected is retained and recognised as income (merchandise_payment_retained) by this group.'
    WHERE id = v_id;
  END LOOP;
END $retained$;

-- ---------------------------------------------------------------- 7. post-checks
DO $post$
DECLARE v_bad int; v_n int; v_amt numeric;
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_disburse_smartphone_order(uuid, numeric, text)'))
       IS DISTINCT FROM '2034e5c247e2cf8eacfbd5573873f3f3'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.apply_smartphone_roi_pledge(uuid, numeric, text)'))
       IS DISTINCT FROM 'c220bb27f307d55f43dfb6a8d37eff8e'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.ledger_category_allowlist()'))
       IS DISTINCT FROM '0cf8f4c90c5fc99832b276f8615a3423'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_stock_receivable_due(uuid)'))
       IS DISTINCT FROM '207408ebee59bc98fd0b0b37e2983857'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_stock_queue(uuid, text)'))
       IS DISTINCT FROM '89553dbcc1749ad9ade915c8bd4ad19a'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_post_stock_recognition(uuid, text, text, uuid)'))
       IS DISTINCT FROM '02ef461b3be40455767aedf0582c9351'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_post_merchandise_stock_recognition(uuid, text)'))
       IS DISTINCT FROM 'bd7bb30d5d5278a08c75c6633fdce853'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_stock_on_handover(uuid)'))
       IS DISTINCT FROM 'eb39ed08009547bc584c086c92bf2091'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_receivable_event(uuid, uuid, text)'))
       IS DISTINCT FROM 'a3ebe03834ff09f9de34b026df3a4a40'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_post_derecognition(uuid, text, text, uuid)'))
       IS DISTINCT FROM 'e1f4951ad940b1b85099f6c379bddd42'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_post_merchandise_derecognition(uuid, text, text)'))
       IS DISTINCT FROM '7566061334de00933825b532351da9d9'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.trg_merch_stock_issue_event()'))
       IS DISTINCT FROM '6cc969e183f4d4733ba7e51c28eb3308' THEN
    RAISE EXCEPTION 'merchandise phase 3: post-check failed (function fingerprints)';
  END IF;
  IF NOT (public.ledger_category_allowlist() @> ARRAY['merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained']) THEN
    RAISE EXCEPTION 'merchandise phase 3: categories not allowlisted';
  END IF;
  -- the 8 smartphone groups: two platform legs each, balanced raw and on mapped accounts, 5,245,000 in total
  SELECT count(*), COALESCE(sum(amt), 0) INTO v_n, v_amt FROM (
    SELECT g.transaction_group_id, sum(g.amount) FILTER (WHERE g.direction = 'cash_in') amt
    FROM public.general_ledger g
    JOIN public.ledger_account_map m ON m.ledger_scope = g.ledger_scope AND m.category = g.category AND m.wallet_bucket IS NULL
    WHERE g.idempotency_key LIKE 'merch\_phase3\_20261104:%:PHONE\_MEMO'
    GROUP BY 1
    HAVING count(*) = 2 AND bool_and(g.ledger_scope = 'platform')
       AND sum(CASE WHEN g.direction = m.debit_when THEN g.amount ELSE -g.amount END) = 0
       AND sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) = 0) z;
  IF v_n <> 8 OR v_amt <> 5245000 THEN
    RAISE EXCEPTION 'merchandise phase 3: smartphone correction post-check failed (% groups, %)', v_n, v_amt;
  END IF;
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_n, v_amt FROM public.merchandise_stock_recognitions WHERE origin = 'historical_20261104' AND status = 'pending';
  IF v_n <> 7 OR v_amt <> 1015000 THEN
    RAISE EXCEPTION 'merchandise phase 3: company-stock queue post-check failed (% rows, %)', v_n, v_amt;
  END IF;
  IF (SELECT count(*) FROM public.merchandise_receivable_derecognitions WHERE sale_id IN ('dddc2333-efb2-4855-9ab7-f3d5c3793873', '54c4c664-6004-4aab-a56c-b285050633cd')
        AND status = 'no_action' AND counterpart = 'retained' AND 'retained_payment' = ANY (flags) AND NOT 'possible_refund' = ANY (flags)) <> 2 THEN
    RAISE EXCEPTION 'merchandise phase 3: rejected-motorcycle review rows not recorded as retained payments';
  END IF;
  -- the two retained-payment groups: DR E3 / CR R1, platform only, 109,554.48
  SELECT count(*), COALESCE(sum(amt), 0) INTO v_n, v_amt FROM (
    SELECT g.transaction_group_id, sum(g.amount) FILTER (WHERE g.direction = 'cash_in') amt
    FROM public.general_ledger g
    JOIN public.ledger_account_map m ON m.ledger_scope = g.ledger_scope AND m.category = g.category AND m.wallet_bucket IS NULL
    WHERE g.idempotency_key LIKE 'merch\_phase3\_20261104:%:RETAINED'
    GROUP BY 1
    HAVING count(*) = 2 AND bool_and(g.ledger_scope = 'platform')
       AND sum(CASE WHEN g.direction = m.debit_when THEN g.amount ELSE -g.amount END) = 0
       AND sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) = 0
       AND bool_or(m.account_code = 'E3') AND bool_or(m.account_code = 'R1')) z;
  IF v_n <> 2 OR v_amt <> 109554.48 THEN
    RAISE EXCEPTION 'merchandise phase 3: retained-payment post-check failed (% groups, %)', v_n, v_amt;
  END IF;
  IF (SELECT stock_issue_counterpart FROM public.merchandise_accounting_controls WHERE id) IS DISTINCT FROM 'revenue'
     OR EXISTS (SELECT 1 FROM public.merchandise_stock_recognitions WHERE status = 'posted') THEN
    RAISE EXCEPTION 'merchandise phase 3: stock recognition must be automatic on handover only, and nothing posted yet';
  END IF;
  IF has_function_privilege('authenticated', 'public._merch_post_stock_recognition(uuid, text, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._merch_stock_queue(uuid, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.merchandise_stock_recognitions', 'INSERT')
     OR has_table_privilege('anon', 'public.merchandise_stock_recognitions', 'SELECT')
     OR has_function_privilege('authenticated', 'public._merch_stock_on_handover(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cfo_post_merchandise_stock_recognition(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'merchandise phase 3: grants not as intended';
  END IF;
END $post$;
