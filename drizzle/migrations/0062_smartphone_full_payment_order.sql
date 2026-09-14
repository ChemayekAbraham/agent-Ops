-- Full-payment smartphone orders: no repayment schedule, the device amount is
-- collected from the agent's wallet once the phone is released.
CREATE OR REPLACE FUNCTION public.agent_order_smartphone_full(p_catalog_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_elig jsonb;
  v_cat public.smartphone_catalog;
  v_price numeric;
  v_name text;
  v_phone text;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_cat FROM public.smartphone_catalog WHERE id = p_catalog_id AND is_active;
  IF v_cat.id IS NULL THEN
    RAISE EXCEPTION 'Selected phone is not available';
  END IF;

  v_price := COALESCE(v_cat.default_amount, 0);
  IF v_price <= 0 THEN
    RAISE EXCEPTION 'Selected phone has no price set';
  END IF;

  v_elig := public.get_agent_smartphone_eligibility(v_uid);
  IF (v_elig->>'has_open_application')::boolean THEN
    RAISE EXCEPTION 'You already have an application in progress';
  END IF;

  SELECT full_name, phone INTO v_name, v_phone FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, total_revenue, total_amount,
    client_name, client_phone, customer_id, created_by,
    payment_status, payment_plan, order_status, sale_date,
    brand, model_type,
    smartphone_catalog_id, supplier_id,
    advance_period_months, advance_markup_pct, total_repayable,
    access_daily_amount, access_repayment_days, grace_days,
    applicant_rank, rank_cap, payment_projection,
    amount_outstanding, amount_paid,
    notes
  ) VALUES (
    'Welile Smartphone', 1, v_price, v_price, v_price,
    v_name, v_phone, v_uid, v_uid,
    'credit', 'full', 'pending_approval', current_date,
    v_cat.brand, v_cat.model_name,
    v_cat.id, v_cat.supplier_id,
    NULL, 0, v_price,
    0, 0, 0,
    (v_elig->>'rank')::int, (v_elig->>'max_amount')::numeric, 0,
    0, 0,
    'Smartphone application (full payment) - ' || v_cat.brand || ' ' || COALESCE(v_cat.model_name, '')
  ) RETURNING id INTO v_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'smartphone_advance_requested', 'merchandise_sales', v_id,
            'Agent submitted a full-payment smartphone application for Agent Ops review',
            jsonb_build_object('price', v_price, 'payment_plan', 'full'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', v_id,
    'order_status', 'pending_approval',
    'payment_plan', 'full',
    'total_repayable', v_price
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_order_smartphone_full(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_order_smartphone_full(uuid) TO authenticated;

-- Full-payment orders must not be given a reducing-balance schedule when the
-- CFO releases the phone.
CREATE OR REPLACE FUNCTION public.smartphone_rebuild_repayment_schedule(
  p_sale_id uuid,
  p_amount numeric,
  p_months integer,
  p_start date
)
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
  IF COALESCE(p_months, 0) NOT IN (3, 6, 9, 12) THEN
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

REVOKE ALL ON FUNCTION public.smartphone_rebuild_repayment_schedule(uuid, numeric, integer, date) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.cfo_disburse_smartphone_order(
  p_sale_id uuid,
  p_amount numeric DEFAULT NULL::numeric,
  p_note text DEFAULT NULL::text
)
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
  v_group uuid;
  v_supplier uuid;
  v_agent uuid;
  v_agent_name text;
  v_agent_phone text;
  v_supplier_name text;
  v_plan_id uuid;
BEGIN

  IF auth.uid() IS NOT NULL AND NOT public.is_cfo_approver(auth.uid()) THEN
    RAISE EXCEPTION 'Only the designated CFO approver may action CFO Dashboard requests';
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

  PERFORM public.assert_smartphone_pickup_verified(v_agent);

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

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_supplier,
        'amount', v_price,
        'direction', 'cash_in',
        'category', 'supplier_payment',
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
            'CFO paid the registered supplier and released the phone after collection-day verification',
            jsonb_build_object('price', v_price, 'total_repayable', v_total,
                               'first_daily', v_daily, 'starts_on', v_start,
                               'schedule', v_sched,
                               'supplier_id', v_supplier, 'repaid_by_agent_id', v_agent,
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
    'recovery_plan_id', v_plan_id,
    'repaid_by_agent_id', v_agent,
    'paid_supplier_id', v_supplier,
    'schedule', v_sched
  );
END;
$function$;