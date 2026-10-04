-- Agent Ops -> COO -> CFO smartphone advance flow.
-- The two review stages can now record the access amount (down payment Welile
-- releases), the repayment period and the daily deduction, which is what the
-- review dialog sends. Previously those parameters did not exist on the
-- functions, so PostgREST rejected the call ("could not find the function ...
-- in the schema cache").
DROP FUNCTION IF EXISTS public.agent_ops_approve_smartphone_order(uuid, text);
DROP FUNCTION IF EXISTS public.coo_approve_smartphone_order(uuid, text);
DROP FUNCTION IF EXISTS public.cfo_disburse_smartphone_order(uuid, text);

CREATE OR REPLACE FUNCTION public.smartphone_apply_review_terms(
  p_sale_id uuid,
  p_total_amount numeric,
  p_repayment_days integer,
  p_daily_deduction numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_amount numeric := NULLIF(p_total_amount, 0);
  v_days integer := NULLIF(p_repayment_days, 0);
  v_daily numeric := NULLIF(p_daily_deduction, 0);
  v_total numeric;
BEGIN
  IF v_amount IS NULL AND v_days IS NULL AND v_daily IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(v_amount, NULLIF(total_amount, 0), NULLIF(unit_price, 0), 0)
    INTO v_total
  FROM public.merchandise_sales WHERE id = p_sale_id;

  -- Access amount plus the standard 33% access fee.
  v_total := round(v_total * 1.33);

  UPDATE public.merchandise_sales
  SET total_amount = COALESCE(v_amount, total_amount),
      unit_price = COALESCE(v_amount, unit_price),
      access_repayment_days = COALESCE(v_days, access_repayment_days),
      total_repayable = v_total,
      access_daily_amount = COALESCE(
        v_daily,
        CASE WHEN COALESCE(v_days, access_repayment_days, 0) > 0
             THEN ceil(v_total / COALESCE(v_days, access_repayment_days))
             ELSE access_daily_amount END),
      payment_projection = v_total - COALESCE(v_amount, NULLIF(total_amount, 0), 0)
  WHERE id = p_sale_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.agent_ops_approve_smartphone_order(
  p_sale_id uuid,
  p_total_amount numeric DEFAULT NULL,
  p_repayment_days integer DEFAULT NULL,
  p_daily_deduction numeric DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
BEGIN
  IF NOT public.can_ops_approve_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to approve smartphone applications';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') NOT IN ('pending_approval','submitted') THEN
    RAISE EXCEPTION 'Application is already %', v_sale.order_status;
  END IF;

  PERFORM public.smartphone_apply_review_terms(p_sale_id, p_total_amount, p_repayment_days, p_daily_deduction);

  UPDATE public.merchandise_sales
  SET order_status = 'ops_approved',
      ops_approved_by = v_uid,
      ops_approved_at = now(),
      notes = COALESCE(notes, '') || ' | Agent Ops approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason)
    VALUES (v_uid, 'smartphone_advance_ops_approved', 'merchandise_sales', p_sale_id,
            'Agent Ops verified eligibility and forwarded the smartphone advance to the COO');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id;

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'ops_approved',
                            'total_amount', v_sale.total_amount,
                            'access_daily_amount', v_sale.access_daily_amount,
                            'access_repayment_days', v_sale.access_repayment_days);
END;
$function$;

CREATE OR REPLACE FUNCTION public.coo_approve_smartphone_order(
  p_sale_id uuid,
  p_total_amount numeric DEFAULT NULL,
  p_repayment_days integer DEFAULT NULL,
  p_daily_deduction numeric DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
BEGIN
  IF NOT public.can_coo_approve_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to approve smartphone applications';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'ops_approved' THEN
    RAISE EXCEPTION 'Application must be approved by Agent Ops first (currently %)', COALESCE(v_sale.order_status, 'submitted');
  END IF;

  PERFORM public.smartphone_apply_review_terms(p_sale_id, p_total_amount, p_repayment_days, p_daily_deduction);

  UPDATE public.merchandise_sales
  SET order_status = 'coo_approved',
      coo_approved_by = v_uid,
      coo_approved_at = now(),
      notes = COALESCE(notes, '') || ' | COO approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' - forwarded to CFO for supplier payment'
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason)
    VALUES (v_uid, 'smartphone_advance_coo_approved', 'merchandise_sales', p_sale_id,
            'COO approved the smartphone advance and forwarded it to the CFO for supplier payment');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id;

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'coo_approved',
                            'total_amount', v_sale.total_amount,
                            'access_daily_amount', v_sale.access_daily_amount,
                            'access_repayment_days', v_sale.access_repayment_days);
END;
$function$;

CREATE OR REPLACE FUNCTION public.cfo_disburse_smartphone_order(
  p_sale_id uuid,
  p_amount numeric DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
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

  -- The applying agent always carries the repayment, never the supplier.
  v_agent := v_sale.customer_id;

  -- Collection-day verification gate.
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

  -- The CFO may confirm/adjust the amount actually released to the supplier.
  v_price := COALESCE(NULLIF(p_amount, 0), NULLIF(v_sale.total_amount, 0), NULLIF(v_sale.unit_price, 0), 0);
  IF v_price <= 0 THEN
    RAISE EXCEPTION 'Phone price is missing on this application';
  END IF;

  v_days  := COALESCE(NULLIF(v_sale.access_repayment_days, 0),
                      public.smartphone_period_days(COALESCE(v_sale.advance_period_months, 12)), 365);
  v_total := COALESCE(NULLIF(v_sale.total_repayable, 0),
                      round(v_price + v_price * COALESCE(v_sale.advance_markup_pct, 42) / 100));
  v_daily := COALESCE(NULLIF(v_sale.access_daily_amount, 0), ceil(v_total::numeric / v_days));
  v_start := current_date + COALESCE(NULLIF(v_sale.grace_days, 0), 7);

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
              || ' - daily ' || to_char(v_daily, 'FM999,999,999')
              || ' from ' || to_char(v_start, 'YYYY-MM-DD')
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  -- Repayment plan for the APPLYING AGENT. Idempotent: one plan per sale.
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
                               'daily', v_daily, 'starts_on', v_start,
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
    'paid_supplier_id', v_supplier
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.smartphone_apply_review_terms(uuid, numeric, integer, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_ops_approve_smartphone_order(uuid, numeric, integer, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.coo_approve_smartphone_order(uuid, numeric, integer, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_disburse_smartphone_order(uuid, numeric, text) TO authenticated;