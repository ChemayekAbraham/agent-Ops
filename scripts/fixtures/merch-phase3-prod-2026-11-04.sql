-- Verbatim production copies (2026-11-04, read-only export via pg_get_functiondef, project byrzshwlentqvktcksem) for
-- src/test/merchandisePhase3.test.ts. md5(prosrc):
--   cfo_disburse_smartphone_order(uuid,numeric,text)             a3642e31906685a7cee1dbea3462ea1e
--   smartphone_rebuild_repayment_schedule(uuid,numeric,integer,date) fb7afcb0991fdedfc48c25451afa21ad
--   can_cfo_disburse_smartphone_orders(uuid)                     af9691e54ad5e2e74f92b81decf18f9c
--   apply_smartphone_roi_pledge(uuid,numeric,text)               74ae9dca248b4b92e6e81a3bd472d997
--   confirm_merchandise_handover(uuid,text)                      d898da35ded74227db95050746273af5
--   agent_ops_approve_merchandise_order(uuid)                    4375d08800ce67d3a9b869b178eb9cdc
--   agent_ops_issue_agent_product(uuid,text,integer,numeric,numeric,uuid,text,numeric,text,numeric) d7c8a0423e38fa1a214762f9e8406f29
--   _has_enabled_role(uuid,text[])                               d6ffa5096fedec926c3daf15d2af1aec
--   _agent_products_authorized()                                 23a6aea1b9f0d131190868a9d99d67fb
--   reject_bike_lease(uuid,text)                                 626a4651815970e8f1e1fe30a668c106
--   can_review_bike_leases(uuid)                                 1f93a9b22edbcc53543b1fe15d799813

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
      jsonb_build_object(
        'user_id', v_uid, 'amount', v_price, 'direction', 'cash_out',
        'category', 'equipment_expense', 'ledger_scope', 'platform',
        'source_table', 'merchandise_sales', 'source_id', p_sale_id,
        'reference_id', v_ref, 'currency', 'UGX',
        'description', 'Smartphone purchased from ' || COALESCE(v_supplier_name, 'supplier')
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
        jsonb_build_object(
          'user_id', v_agent, 'amount', v_price, 'direction', 'cash_out',
          'category', 'smartphone_advance_receivable', 'ledger_scope', 'platform',
          'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_adv_ref, 'currency', 'UGX',
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

CREATE OR REPLACE FUNCTION public.smartphone_rebuild_repayment_schedule(p_sale_id uuid, p_amount numeric, p_months integer, p_start date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric := 0;
  v_charge numeric := 0;
  v_days integer := 0;
  v_first numeric := 0;
  v_last numeric := 0;
  v_rows integer := 0;
BEGIN
  DELETE FROM public.smartphone_repayment_schedules WHERE sale_id = p_sale_id;

  -- No period means full payment: nothing to schedule.
  IF COALESCE(p_months, 0) NOT BETWEEN 1 AND 12 THEN
    RETURN jsonb_build_object(
      'sale_id', p_sale_id, 'months', 0, 'days', 0, 'total_charge', 0,
      'total_repayable', GREATEST(0, round(COALESCE(p_amount, 0))),
      'first_daily', 0, 'last_daily', 0, 'payment_plan', 'full'
    );
  END IF;

  INSERT INTO public.smartphone_repayment_schedules (
    sale_id, month_index, period_start, period_end, days_in_period,
    opening_principal, principal_due, charge_due, total_due, daily_deduction
  )
  SELECT p_sale_id, s.month_index, s.period_start, s.period_end, s.days_in_period,
         s.opening_principal, s.principal_due, s.charge_due, s.total_due, s.daily_deduction
  FROM public.smartphone_reducing_schedule(p_amount, p_months, p_start) s;

  SELECT COALESCE(sum(total_due), 0), COALESCE(sum(charge_due), 0),
         COALESCE(sum(days_in_period), 0), count(*)
    INTO v_total, v_charge, v_days, v_rows
  FROM public.smartphone_repayment_schedules WHERE sale_id = p_sale_id;

  SELECT daily_deduction INTO v_first
  FROM public.smartphone_repayment_schedules
  WHERE sale_id = p_sale_id ORDER BY month_index ASC LIMIT 1;

  SELECT daily_deduction INTO v_last
  FROM public.smartphone_repayment_schedules
  WHERE sale_id = p_sale_id ORDER BY month_index DESC LIMIT 1;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'months', v_rows,
    'days', v_days,
    'total_charge', v_charge,
    'total_repayable', v_total,
    'first_daily', COALESCE(v_first, 0),
    'last_daily', COALESCE(v_last, 0),
    'payment_plan', 'installments'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.can_cfo_disburse_smartphone_orders(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.has_role(_user_id, 'cfo')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
$function$;

CREATE OR REPLACE FUNCTION public.apply_smartphone_roi_pledge(p_user_id uuid, p_roi_amount numeric, p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_p record; v_plan record; v_pledged numeric; v_avail numeric; v_amount numeric; v_closing numeric;
  v_split jsonb; v_prin_part numeric; v_charge_part numeric; v_entries jsonb;
BEGIN
  IF COALESCE(p_roi_amount,0) <= 0 THEN RETURN jsonb_build_object('applied',0,'reason','no_roi'); END IF;
  IF EXISTS (SELECT 1 FROM public.smartphone_roi_pledge_applications WHERE reference = p_reference) THEN
    RETURN jsonb_build_object('applied',0,'reason','already_applied');
  END IF;
  SELECT * INTO v_p FROM public.smartphone_roi_pledges WHERE user_id = p_user_id AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',0,'reason','no_pledge'); END IF;
  SELECT p.* INTO v_plan FROM public.merchandise_recovery_plans p
    JOIN public.merchandise_sales s ON s.id = p.sale_id
    WHERE p.customer_id = p_user_id AND p.status = 'active' AND p.outstanding_balance > 0
      AND NOT COALESCE(p.is_bike_lease,false) AND s.item_name ILIKE '%smartphone%'
    ORDER BY p.created_at LIMIT 1 FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',0,'reason','no_plan'); END IF;
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

CREATE OR REPLACE FUNCTION public.confirm_merchandise_handover(p_sale_id uuid, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_sale public.merchandise_sales; v_plan uuid;
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['cmo','agent_ops','manager','super_admin']) THEN
    RAISE EXCEPTION 'Only a company handler can confirm a handover';
  END IF;
  IF length(trim(COALESCE(p_note,''))) < 10 THEN RAISE EXCEPTION 'Add a handover note of at least 10 characters'; END IF;
  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_sale.fulfilment_type IS DISTINCT FROM 'company_issued' THEN RAISE EXCEPTION 'Only company issued items are handed over'; END IF;
  IF v_sale.handed_over_at IS NOT NULL THEN RAISE EXCEPTION 'This item was already handed over'; END IF;
  IF v_sale.order_status <> 'awaiting_handover' THEN
    RAISE EXCEPTION 'Order is not fully approved yet (status: %)', v_sale.order_status;
  END IF;
  UPDATE public.merchandise_sales
  SET handed_over_by = auth.uid(), handed_over_at = now(), handover_note = trim(p_note),
      order_status = 'issued', updated_at = now()
  WHERE id = p_sale_id;
  v_plan := public._merch_create_plan_for_sale(p_sale_id);
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 'merchandise_handover_confirmed', 'merchandise_sales', p_sale_id::text, trim(p_note),
          jsonb_build_object('item_name', v_sale.item_name, 'plan_id', v_plan));
  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, entity_type, entity_id, metadata)
    VALUES ('merchandise.handover_confirmed', auth.uid(), v_sale.customer_id, 'merchandise_sales', p_sale_id,
            jsonb_build_object('item_name', v_sale.item_name, 'total', v_sale.total_revenue));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN p_sale_id;
END $function$;

CREATE OR REPLACE FUNCTION public.agent_ops_approve_merchandise_order(p_sale_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_status text; v_item text;
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to approve agent product applications';
  END IF;
  SELECT lower(COALESCE(order_status,'')), item_name INTO v_status, v_item
  FROM public.merchandise_sales WHERE id = p_sale_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Application not found'; END IF;
  IF v_status IN ('rejected','cancelled','declined') THEN RAISE EXCEPTION 'Application is already closed'; END IF;

  IF public.agent_product_category(v_item) = 'boutique' THEN
    IF v_status NOT IN ('pending_approval','submitted','processing') THEN
      RAISE EXCEPTION 'Boutique order is already past Agent Ops review (status: %)', v_status;
    END IF;
    UPDATE public.merchandise_sales
    SET order_status = 'ops_approved', ops_approved_by = auth.uid(), ops_approved_at = now(), updated_at = now()
    WHERE id = p_sale_id;
    RETURN p_sale_id;
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'issued', ops_approved_by = auth.uid(), ops_approved_at = now(), updated_at = now()
  WHERE id = p_sale_id;
  RETURN p_sale_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.agent_ops_issue_agent_product(p_agent_id uuid, p_item_name text, p_quantity integer, p_unit_price numeric, p_unit_cost numeric, p_service_centre_id uuid, p_payment_plan text, p_amount_paid numeric, p_notes text, p_recovery_rate numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric;
  v_paid numeric;
  v_sale uuid;
  v_profile record;
  v_rate numeric;
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to issue agent products';
  END IF;
  IF p_agent_id IS NULL OR COALESCE(TRIM(p_item_name),'') = '' THEN
    RAISE EXCEPTION 'Agent and product are required';
  END IF;
  IF COALESCE(p_quantity,0) <= 0 OR COALESCE(p_unit_price,0) <= 0 THEN
    RAISE EXCEPTION 'Quantity and unit price must be greater than zero';
  END IF;
  IF COALESCE(p_payment_plan,'installment') NOT IN ('full','installment') THEN
    RAISE EXCEPTION 'Invalid payment plan';
  END IF;
  IF p_recovery_rate IS NOT NULL AND (p_recovery_rate <= 0 OR p_recovery_rate > 1) THEN
    RAISE EXCEPTION 'Recovery rate must be between 0 and 1';
  END IF;

  SELECT full_name, phone INTO v_profile FROM public.profiles WHERE id = p_agent_id;
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'Agent profile not found';
  END IF;

  v_total := p_quantity * p_unit_price;
  v_paid := LEAST(GREATEST(COALESCE(p_amount_paid,0), 0), v_total);
  IF COALESCE(p_payment_plan,'installment') = 'full' THEN
    v_paid := v_total;
  END IF;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, notes,
    payment_plan, order_status, service_centre_id, issued_channel, created_by
  ) VALUES (
    TRIM(p_item_name), p_quantity, p_unit_price, COALESCE(p_unit_cost,0), v_total,
    v_profile.full_name, v_profile.phone, p_agent_id,
    CASE WHEN v_paid >= v_total THEN 'paid' WHEN v_paid > 0 THEN 'partial' ELSE 'credit' END,
    v_paid, v_total - v_paid, CURRENT_DATE, p_notes,
    COALESCE(p_payment_plan,'installment'), 'approved', p_service_centre_id, 'agent_ops', auth.uid()
  ) RETURNING id INTO v_sale;

  v_rate := p_recovery_rate;
  IF v_rate IS NULL AND (lower(TRIM(p_item_name)) LIKE '%phone%' OR lower(TRIM(p_item_name)) LIKE '%bike%') THEN
    v_rate := 0.33;
  END IF;

  IF v_rate IS NOT NULL THEN
    UPDATE public.merchandise_recovery_plans
    SET daily_rate = v_rate
    WHERE sale_id = v_sale;
  END IF;

  RETURN v_sale;
END;
$function$;

CREATE OR REPLACE FUNCTION public._has_enabled_role(p_user uuid, p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = p_user AND enabled AND role::text = ANY (p_roles))
$function$;

CREATE OR REPLACE FUNCTION public._agent_products_authorized()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.has_role(auth.uid(), 'agent_ops')
      OR public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'coo')
      OR public.has_role(auth.uid(), 'ceo')
      OR public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'cmo')
      OR public.has_role(auth.uid(), 'super_admin')
$function$;

CREATE OR REPLACE FUNCTION public.reject_bike_lease(p_sale_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
BEGIN
  IF NOT public.can_review_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to reject Spiro bike lease applications';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Provide a rejection reason of at least 10 characters';
  END IF;

  SELECT COALESCE(order_status, 'submitted') INTO v_status
  FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF v_status NOT IN ('submitted','pending_approval','ops_approved','coo_approved') THEN
    RAISE EXCEPTION 'Application is already %', v_status;
  END IF;
  IF v_status = 'coo_approved' AND NOT public.can_cfo_disburse_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Only the CFO can reject an application already approved by the COO';
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'rejected',
      rejection_reason = btrim(p_reason),
      notes = COALESCE(notes, '') || ' | Rejected ' || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' - ' || btrim(p_reason)
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason)
    VALUES (v_uid, 'bike_lease_rejected', 'merchandise_sales', p_sale_id, btrim(p_reason));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'rejected');
END;
$function$;

CREATE OR REPLACE FUNCTION public.can_review_bike_leases(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.has_role(_user_id, 'coo')
      OR public.has_role(_user_id, 'cfo')
      OR public.has_role(_user_id, 'agent_ops')
      OR public.has_role(_user_id, 'operations')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
$function$;
