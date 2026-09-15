-- Fix the smartphone disbursement: the supplier wallet leg used the
-- non-allowlisted category 'supplier_payment', which the wallet routing gate
-- rejects (WALLET_ROUTING_REQUIRED / UNSUPPORTED_LEDGER_CATEGORY). Use the
-- allowlisted 'wallet_deposit' category, and additionally record the phone cost
-- as an advance (debt) on the applying agent's wallet using the same structure
-- as a normal agent advance disbursement:
--   DR A4 advances receivable (platform agent_repayment cash_out)
--   CR L1 custody payable    (wallet agent_advance_credit cash_in, bucket advance_credit)
CREATE OR REPLACE FUNCTION public.cfo_disburse_smartphone_order(
  p_sale_id uuid,
  p_amount numeric DEFAULT NULL::numeric,
  p_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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

  -- National ID and workplace photo are collection-day checks, not a
  -- disbursement prerequisite. Deliberately not gated here.

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

  v_full := COALESCE(v_sale.payment_plan, '') = 'full'
            OR COALESCE(v_sale.advance_period_months, 0) NOT IN (3, 6, 9, 12);
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
        'user_id', v_supplier,
        'amount', v_price,
        'direction', 'cash_in',
        'category', 'wallet_deposit',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'wallet_bucket', 'withdrawable',
        'source_table', 'merchandise_sales',
        'source_id', p_sale_id,
        'reference_id', v_ref,
        'currency', 'UGX',
        'description', 'Smartphone supplier payment for ' || COALESCE(v_agent_name, 'agent'),
        'transaction_date', now()
      ),
      jsonb_build_object(
        'user_id', v_uid,
        'amount', v_price,
        'direction', 'cash_out',
        'category', 'equipment_expense',
        'ledger_scope', 'platform',
        'source_table', 'merchandise_sales',
        'source_id', p_sale_id,
        'reference_id', v_ref,
        'currency', 'UGX',
        'description', 'Smartphone purchased from ' || COALESCE(v_supplier_name, 'supplier')
                       || ' for ' || COALESCE(v_agent_name, 'agent'),
        'transaction_date', now()
      )
    ),
    v_ref
  );

  -- Record the phone cost as an advance (debt) on the applying agent's wallet.
  IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_adv_ref) THEN
    v_adv_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_agent,
          'amount', v_price,
          'direction', 'cash_in',
          'category', 'agent_advance_credit',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'wallet_bucket', 'advance_credit',
          'source_table', 'merchandise_sales',
          'source_id', p_sale_id,
          'reference_id', v_adv_ref,
          'currency', 'UGX',
          'description', 'Smartphone advance recorded on wallet - '
                         || COALESCE(v_sale.item_name, 'Welile Smartphone'),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_agent,
          'amount', v_price,
          'direction', 'cash_out',
          'category', 'agent_repayment',
          'ledger_scope', 'platform',
          'source_table', 'merchandise_sales',
          'source_id', p_sale_id,
          'reference_id', v_adv_ref,
          'currency', 'UGX',
          'description', 'Smartphone advance receivable from ' || COALESCE(v_agent_name, 'agent'),
          'transaction_date', now()
        )
      ),
      v_adv_ref
    );
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      payment_status = 'credit',
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
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'total_amount', v_price,
    'disbursed_amount', v_price,
    'payment_projection', v_total - v_price,
    'daily_amount', v_daily,
    'repayment_starts_on', v_start,
    'disbursement_group_id', v_group,
    'advance_group_id', v_adv_group,
    'advance_recorded', v_price,
    'recovery_plan_id', v_plan_id,
    'repaid_by_agent_id', v_agent,
    'paid_supplier_id', v_supplier,
    'schedule', v_sched
  );
END;
$fn$;

-- Supplier payout account details for the CFO disbursement screen.
CREATE OR REPLACE FUNCTION public.get_smartphone_supplier_payout_details(p_sale_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_supplier uuid;
  v_row record;
  v_pm record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'This request could not be completed';
  END IF;
  IF NOT (
    public.is_cfo_approver(v_uid)
    OR public.has_role(v_uid, 'cfo'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role)
    OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'This request could not be completed';
  END IF;

  SELECT COALESCE(ms.supplier_id, sc.supplier_id) INTO v_supplier
  FROM public.merchandise_sales ms
  LEFT JOIN public.smartphone_catalog sc ON sc.id = ms.smartphone_catalog_id
  WHERE ms.id = p_sale_id;

  IF v_supplier IS NULL THEN
    RETURN jsonb_build_object('supplier_id', NULL);
  END IF;

  SELECT id, full_name, phone, email INTO v_row FROM public.profiles WHERE id = v_supplier;

  SELECT payout_mode, momo_provider, momo_number, momo_name,
         bank_name, bank_account_name, bank_account_number
  INTO v_pm
  FROM public.saved_payout_methods
  WHERE user_id = v_supplier
  ORDER BY is_default DESC, last_used_at DESC NULLS LAST, created_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'supplier_id', v_supplier,
    'full_name', v_row.full_name,
    'phone', v_row.phone,
    'email', v_row.email,
    'payout_mode', v_pm.payout_mode,
    'momo_provider', v_pm.momo_provider,
    'momo_number', v_pm.momo_number,
    'momo_name', v_pm.momo_name,
    'bank_name', v_pm.bank_name,
    'bank_account_name', v_pm.bank_account_name,
    'bank_account_number', v_pm.bank_account_number
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_smartphone_supplier_payout_details(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_smartphone_supplier_payout_details(uuid) TO authenticated;