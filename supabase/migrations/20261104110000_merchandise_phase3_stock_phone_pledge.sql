-- 2026-11-04: merchandise phase 3. Production apply needs explicit CFO approval.
-- Builds on 20261104090000 (27 one-off corrections) and 20261104100000 (receivable controls); repeats neither.
-- ACCOUNTING ONLY except item 5, which the CFO asked for explicitly. No wallet leg, refund, payment or order status changes.
--   1. Categories: merchandise_revenue (platform -> R1; already used by agent_purchase_merchandise, which would fail under
--      strict mode while it was unmapped and not allowlisted) and merchandise_advance_memo_offset (platform -> L1).
--   2. Smartphone payouts (cfo_disburse_smartphone_order), company-side legs only: the phone's cost is the A12 receivable
--      (was X1 expense) and the advance shown on the agent's wallet is offset in L1 (was a second A12 debit).
--   3. One-off: 8 historical payouts, DR L1 / CR X1 5,245,000 (the X1 expense and the L1 agent memo counted the same phone).
--   4. Company stock issued on credit: queued for the CFO in merchandise_stock_recognitions (one row per order) on every
--      issue path; the CFO recognises it (revenue; E3 only for items issued before these controls) once, or sets
--      merchandise_accounting_controls.stock_issue_counterpart = 'revenue' to recognise on issue automatically.
--   5. Monthly Returns smartphone pledge (apply_smartphone_roi_pledge): collects only on an approved, delivered order
--      (merchandise_plan_recovery_eligible); an ineligible order is skipped and recorded in audit_logs. Accounting
--      unchanged; the Returns payout is never affected.
--   6. Review rows, no posting: the 7 company-stock items (1,015,000) and the 2 bikes rejected with cash kept (109,554.48).
-- Rollback: supabase/rollbacks/20261104110000_merchandise_phase3_stock_phone_pledge.rollback.sql (functions, triggers and mapping; posted entries and review rows stay).
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
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.merchandise_plan_recovery_eligible(uuid)'))
       IS DISTINCT FROM 'fd52204a0662a4353f1e1fb32c278ad2'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.merchandise_plan_ineligible_reason(uuid)'))
       IS DISTINCT FROM '44555b63befb3652e1bb7be108505bb6' THEN
    RAISE EXCEPTION 'merchandise phase 3: preflight refused - a function differs from the production definition of 2026-11-04';
  END IF;
  IF to_regclass('public.merchandise_stock_recognitions') IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.ledger_account_map WHERE category IN ('merchandise_revenue', 'merchandise_advance_memo_offset'))
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE category IN ('merchandise_revenue', 'merchandise_advance_memo_offset')) THEN
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
END $pre$;

-- ---------------------------------------------------------------- 1. categories
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes) VALUES
  ('platform', 'merchandise_revenue', NULL, 'R1', 'cash_out', '2026-11-04 (CFO): merchandise sales revenue (company stock sold on credit or for cash)'),
  ('platform', 'merchandise_advance_memo_offset', NULL, 'L1', 'cash_out',
   '2026-11-04 (CFO): offsets the advance shown on an agent''s wallet (advance_credit) for goods the company paid for; not money owed to the agent');

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
    || ARRAY['merchandise_revenue', 'merchandise_advance_memo_offset']::text[];
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
  'CFO decision. NULL (default): an issue of company stock on credit is queued in merchandise_stock_recognitions for the '
  'CFO. ''revenue'': the receivable is recognised automatically on issue (DR A12/A13 / CR R1 merchandise_revenue).';

CREATE TABLE public.merchandise_stock_recognitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL UNIQUE,                  -- one row per order, ever
  plan_ids uuid[] NOT NULL DEFAULT '{}',
  item_name text, customer_id uuid, account text NOT NULL CHECK (account IN ('A12', 'A13')),
  origin text NOT NULL CHECK (origin IN ('historical_20261104', 'issue')),
  principal numeric NOT NULL,                    -- order total (price x quantity)
  amount_paid numeric NOT NULL DEFAULT 0,        -- customer payments on the order when queued / posted
  amount numeric NOT NULL,                       -- receivable to recognise: principal not yet paid or already recognised
  flags text[] NOT NULL DEFAULT '{}',            -- no_handover_record, unrecorded_payment, historical
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'no_action')),
  counterpart text CHECK (counterpart IN ('revenue', 'E3')),
  ledger_group_id uuid, idempotency_key text,
  decided_by uuid, decided_at timestamptz, decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.merchandise_stock_recognitions IS
  'Company stock issued to an agent on credit: the receivable to recognise (A12 / A13) and how the CFO recognised it '
  '(revenue, or E3 for items issued before these controls). Written only by the merchandise controls (20261104110000).';
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
DECLARE s record; v jsonb; v_id uuid; v_flags text[] := '{}'; v_auto text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.merchandise_stock_recognitions WHERE sale_id = p_sale) THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.merchandise_sales WHERE id = p_sale;
  v := public._merch_stock_receivable_due(p_sale);
  IF v IS NULL OR (v->>'due')::numeric <= 0 THEN RETURN NULL; END IF;
  IF s.handed_over_at IS NULL THEN v_flags := v_flags || 'no_handover_record'::text; END IF;
  IF (v->>'unrecorded_payment')::numeric > 0 THEN v_flags := v_flags || 'unrecorded_payment'::text; END IF;
  IF p_origin = 'historical_20261104' THEN v_flags := v_flags || 'historical'::text; END IF;
  INSERT INTO public.merchandise_stock_recognitions (sale_id, plan_ids, item_name, customer_id, account, origin, principal,
    amount_paid, amount, flags)
  VALUES (p_sale, ARRAY(SELECT jsonb_array_elements_text(v->'plans'))::uuid[], s.item_name, s.customer_id, v->>'account', p_origin,
    (v->>'principal')::numeric, (v->>'amount_paid')::numeric, (v->>'due')::numeric, v_flags)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 'merchandise_stock_issue_queued', 'merchandise_stock_recognitions', v_id::text, p_origin,
          jsonb_build_object('sale_id', p_sale, 'due', v));
  SELECT stock_issue_counterpart INTO v_auto FROM public.merchandise_accounting_controls WHERE id;
  IF v_auto IS NOT NULL AND p_origin = 'issue' THEN
    PERFORM public._merch_post_stock_recognition(v_id, v_auto, 'automatic on issue', auth.uid());
  END IF;
  RETURN v_id;
END $function$;

CREATE OR REPLACE FUNCTION public._merch_post_stock_recognition(p_review uuid, p_counterpart text, p_note text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; v jsonb; v_amt numeric; v_key text; v_group uuid; v_desc text; v_entries jsonb;
BEGIN
  IF p_counterpart NOT IN ('revenue', 'E3') THEN RAISE EXCEPTION 'counterpart must be revenue or E3'; END IF;
  SELECT * INTO r FROM public.merchandise_stock_recognitions WHERE id = p_review FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock recognition % not found', p_review; END IF;
  IF r.status <> 'pending' THEN
    RETURN jsonb_build_object('id', r.id, 'status', r.status, 'ledger_group_id', r.ledger_group_id, 'already', true);
  END IF;
  IF p_counterpart = 'E3' AND r.origin <> 'historical_20261104' THEN
    RAISE EXCEPTION 'E3 (restatement) is only for items issued before these controls; a current issue is a sale (revenue)';
  END IF;
  -- recomputed now: what was paid or recognised since it was queued is taken into account
  v := public._merch_stock_receivable_due(r.sale_id);
  v_amt := COALESCE((v->>'due')::numeric, 0);
  v_key := 'merch_stock_recog:' || r.id::text;
  IF v_amt > 0 THEN
    v_desc := 'Company stock issued on credit: ' || COALESCE(r.item_name, 'merchandise') || ' - receivable ' || r.account
              || CASE p_counterpart WHEN 'revenue' THEN ' / sales revenue (R1)' ELSE ' / restatement (E3)' END
              || ' - ' || COALESCE(p_note, '');
    IF p_counterpart = 'revenue' THEN
      v_entries := jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_amt,
          'category', CASE r.account WHEN 'A13' THEN 'bike_recovery_repayment' ELSE 'smartphone_advance_receivable' END,
          'source_table', 'merchandise_sales', 'source_id', r.sale_id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_amt, 'category', 'merchandise_revenue',
          'source_table', 'merchandise_sales', 'source_id', r.sale_id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc));
    ELSE
      v_entries := jsonb_build_array(
        jsonb_build_object('ledger_scope', 'bridge', 'direction', 'cash_in', 'amount', v_amt,
          'category', CASE r.account WHEN 'A13' THEN 'bike_recovery_receivable_opening' ELSE 'merchandise_recovery_receivable_opening' END,
          'source_table', 'merchandise_sales', 'source_id', r.sale_id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_amt, 'category', 'receivable_restatement_equity',
          'source_table', 'merchandise_sales', 'source_id', r.sale_id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc));
    END IF;
    v_group := public.create_ledger_transaction(entries => v_entries, idempotency_key => v_key);
  END IF;
  UPDATE public.merchandise_stock_recognitions
  SET status = CASE WHEN v_group IS NULL THEN 'no_action' ELSE 'posted' END,
      counterpart = CASE WHEN v_group IS NULL THEN NULL ELSE p_counterpart END,
      amount = v_amt, amount_paid = COALESCE((v->>'amount_paid')::numeric, amount_paid),
      ledger_group_id = v_group, idempotency_key = CASE WHEN v_group IS NULL THEN NULL ELSE v_key END,
      decided_by = p_actor, decided_at = now(), decision_note = p_note, updated_at = now()
  WHERE id = r.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (p_actor, 'merchandise_stock_recognised', 'merchandise_stock_recognitions', r.id::text, p_note,
          jsonb_build_object('sale_id', r.sale_id, 'counterpart', p_counterpart, 'amount', v_amt, 'ledger_group_id', v_group,
                             'idempotency_key', v_key, 'due', v));
  RETURN jsonb_build_object('id', r.id, 'status', CASE WHEN v_group IS NULL THEN 'no_action' ELSE 'posted' END,
    'ledger_group_id', v_group, 'amount', v_amt, 'counterpart', p_counterpart);
END $function$;

CREATE OR REPLACE FUNCTION public.cfo_post_merchandise_stock_recognition(p_review_id uuid, p_counterpart text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'cfo'::app_role) OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Only the CFO can recognise a company-stock receivable';
  END IF;
  IF p_counterpart IS NULL OR p_counterpart NOT IN ('revenue', 'E3') THEN
    RAISE EXCEPTION 'Choose revenue (a sale) or E3 (restatement, only for items issued before these controls)';
  END IF;
  IF length(btrim(COALESCE(p_note, ''))) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters';
  END IF;
  RETURN public._merch_post_stock_recognition(p_review_id, p_counterpart, btrim(p_note), auth.uid());
END $function$;

-- Every path that puts company stock in an agent's hands on credit with no payout behind it: handover
-- (confirm_merchandise_handover -> issued), Agent Ops approval of a non-boutique order (-> issued), an Agent Ops issue
-- (agent_ops_issue_agent_product: inserted as approved, channel agent_ops) and completion. Orders with a CFO payout
-- (bike, smartphone, out-sourced) open their receivable at payout and are excluded.
CREATE OR REPLACE FUNCTION public.trg_merch_stock_issue_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.cfo_disbursed_at IS NOT NULL OR NEW.disbursement_group_id IS NOT NULL OR NEW.customer_id IS NULL THEN RETURN NULL; END IF;
  IF NOT (NEW.order_status IN ('issued', 'completed') OR (NEW.order_status = 'approved' AND NEW.issued_channel = 'agent_ops')) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.order_status IN ('issued', 'completed')
                           OR (OLD.order_status = 'approved' AND OLD.issued_channel = 'agent_ops')) THEN
    RETURN NULL;
  END IF;
  PERFORM public._merch_stock_queue(NEW.id, 'issue');
  RETURN NULL;
END $function$;
CREATE TRIGGER trg_merch_stock_issue_insert AFTER INSERT ON public.merchandise_sales
  FOR EACH ROW EXECUTE FUNCTION public.trg_merch_stock_issue_event();
CREATE TRIGGER trg_merch_stock_issue_status AFTER UPDATE OF order_status ON public.merchandise_sales
  FOR EACH ROW WHEN (OLD.order_status IS DISTINCT FROM NEW.order_status) EXECUTE FUNCTION public.trg_merch_stock_issue_event();

REVOKE ALL ON FUNCTION public._merch_stock_receivable_due(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_stock_queue(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_post_stock_recognition(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_merch_stock_issue_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cfo_post_merchandise_stock_recognition(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_post_merchandise_stock_recognition(uuid, text, text) TO authenticated;

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
-- 6a. the 7 company-stock items issued 24-25 Sep with nothing posted: queued; the CFO recognises each with
--     cfo_post_merchandise_stock_recognition(id, 'revenue' | 'E3', reason).
SELECT public._merch_stock_queue(v.sale, 'historical_20261104') FROM (VALUES
    ('cdd33740-b2ee-47ab-b49d-1c7a4e23db7b'::uuid, 55000::numeric),
    ('9a8b2824-1241-40a1-b2ec-77519a66d2d4'::uuid, 55000::numeric),
    ('d99c3173-a6c9-4168-af94-02e695cb398c'::uuid, 55000::numeric),
    ('ded6710e-1a30-4f17-9f24-463de40081d4'::uuid, 55000::numeric),
    ('bf40085c-dedc-44ef-9e38-d6170a57209a'::uuid, 650000::numeric),
    ('4cf491c5-21b0-4366-9369-7a210b431013'::uuid, 110000::numeric),
    ('882c5336-b5b0-4108-bbc3-11b004dde5c3'::uuid, 35000::numeric)) v(sale, amt);
-- 6b. the two bikes rejected on 6 Oct with customer cash kept (before the controls existed): review rows flagged
--     possible_refund in merchandise_receivable_derecognitions (receivable already 0; no posting, no refund).
SELECT public._merch_receivable_event(v.sale, NULL, 'historical_review_20261104: rejected 2026-10-06 before the receivable controls; customer cash kept')
FROM (VALUES ('dddc2333-efb2-4855-9ab7-f3d5c3793873'::uuid), ('54c4c664-6004-4aab-a56c-b285050633cd'::uuid)) v(sale);

-- ---------------------------------------------------------------- 7. post-checks
DO $post$
DECLARE v_bad int; v_n int; v_amt numeric;
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_disburse_smartphone_order(uuid, numeric, text)'))
       IS DISTINCT FROM '2034e5c247e2cf8eacfbd5573873f3f3'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.apply_smartphone_roi_pledge(uuid, numeric, text)'))
       IS DISTINCT FROM 'c220bb27f307d55f43dfb6a8d37eff8e'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.ledger_category_allowlist()'))
       IS DISTINCT FROM 'a40a39f6e8eba041720e93fda4de7229'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_stock_receivable_due(uuid)'))
       IS DISTINCT FROM '207408ebee59bc98fd0b0b37e2983857'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_stock_queue(uuid, text)'))
       IS DISTINCT FROM '1a059fc074b3f563f06cc91230b80b81'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_post_stock_recognition(uuid, text, text, uuid)'))
       IS DISTINCT FROM '913d14c37bac81b389d72c5d937f62f3'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_post_merchandise_stock_recognition(uuid, text, text)'))
       IS DISTINCT FROM '03ffd6281d7018dae250eddd3744195c'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.trg_merch_stock_issue_event()'))
       IS DISTINCT FROM '857125ed83e81a62f877b64c28e698d2' THEN
    RAISE EXCEPTION 'merchandise phase 3: post-check failed (function fingerprints)';
  END IF;
  IF NOT (public.ledger_category_allowlist() @> ARRAY['merchandise_revenue', 'merchandise_advance_memo_offset']) THEN
    RAISE EXCEPTION 'merchandise phase 3: categories not allowlisted';
  END IF;
  -- the 8 smartphone groups: two platform legs each, balanced raw and on mapped accounts, 5,245,000 in total
  SELECT count(*), COALESCE(sum(amt), 0) INTO v_n, v_amt FROM (
    SELECT g.transaction_group_id, sum(g.amount) FILTER (WHERE g.direction = 'cash_in') amt
    FROM public.general_ledger g
    JOIN public.ledger_account_map m ON m.ledger_scope = g.ledger_scope AND m.category = g.category AND m.wallet_bucket IS NULL
    WHERE g.idempotency_key LIKE 'merch_phase3_20261104:%'
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
        AND status = 'pending' AND 'possible_refund' = ANY (flags)) <> 2 THEN
    RAISE EXCEPTION 'merchandise phase 3: rejected-bike review rows missing';
  END IF;
  IF has_function_privilege('authenticated', 'public._merch_post_stock_recognition(uuid, text, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._merch_stock_queue(uuid, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.merchandise_stock_recognitions', 'INSERT')
     OR has_table_privilege('anon', 'public.merchandise_stock_recognitions', 'SELECT')
     OR NOT has_function_privilege('authenticated', 'public.cfo_post_merchandise_stock_recognition(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'merchandise phase 3: grants not as intended';
  END IF;
END $post$;
