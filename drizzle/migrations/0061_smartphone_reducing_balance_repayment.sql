-- Reducing-balance smartphone repayment: 28% monthly charge on the opening
-- outstanding principal, equal monthly principal, daily deduction recomputed
-- for each repayment month.

CREATE OR REPLACE FUNCTION public.smartphone_monthly_charge_pct()
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT 28::numeric
$function$;

CREATE OR REPLACE FUNCTION public.smartphone_reducing_schedule(
  p_amount numeric,
  p_months integer,
  p_start date DEFAULT current_date
)
RETURNS TABLE(
  month_index integer,
  period_start date,
  period_end date,
  days_in_period integer,
  opening_principal numeric,
  principal_due numeric,
  charge_due numeric,
  total_due numeric,
  daily_deduction numeric
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_amount numeric := GREATEST(0, round(COALESCE(p_amount, 0)));
  v_months integer := COALESCE(p_months, 12);
  v_start date := COALESCE(p_start, current_date);
  v_rate numeric := public.smartphone_monthly_charge_pct();
  v_per numeric;
  v_open numeric;
  v_m integer;
  v_ps date;
  v_ns date;
BEGIN
  IF v_months NOT IN (3, 6, 9, 12) THEN
    RETURN;
  END IF;
  IF v_amount <= 0 THEN
    RETURN;
  END IF;

  v_per := floor(v_amount / v_months);
  v_open := v_amount;

  FOR v_m IN 1..v_months LOOP
    v_ps := v_start + ((v_m - 1) || ' months')::interval;
    v_ns := v_start + (v_m || ' months')::interval;

    month_index := v_m;
    period_start := v_ps;
    period_end := v_ns - 1;
    days_in_period := GREATEST(1, (v_ns - v_ps));
    opening_principal := v_open;
    principal_due := CASE WHEN v_m = v_months THEN v_open ELSE v_per END;
    charge_due := round(v_open * v_rate / 100);
    total_due := principal_due + charge_due;
    daily_deduction := ceil(total_due / days_in_period);

    RETURN NEXT;

    v_open := v_open - principal_due;
  END LOOP;
END;
$function$;

CREATE TABLE IF NOT EXISTS public.smartphone_repayment_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.merchandise_sales(id) ON DELETE CASCADE,
  month_index integer NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  days_in_period integer NOT NULL,
  opening_principal numeric NOT NULL DEFAULT 0,
  principal_due numeric NOT NULL DEFAULT 0,
  charge_due numeric NOT NULL DEFAULT 0,
  total_due numeric NOT NULL DEFAULT 0,
  daily_deduction numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sale_id, month_index)
);

CREATE INDEX IF NOT EXISTS idx_smartphone_repayment_schedules_sale
  ON public.smartphone_repayment_schedules (sale_id, month_index);
CREATE INDEX IF NOT EXISTS idx_smartphone_repayment_schedules_window
  ON public.smartphone_repayment_schedules (sale_id, period_start, period_end);

GRANT SELECT ON public.smartphone_repayment_schedules TO authenticated;
GRANT ALL ON public.smartphone_repayment_schedules TO service_role;

ALTER TABLE public.smartphone_repayment_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Applicants read their own smartphone schedule" ON public.smartphone_repayment_schedules;
CREATE POLICY "Applicants read their own smartphone schedule"
ON public.smartphone_repayment_schedules
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.merchandise_sales ms
    WHERE ms.id = smartphone_repayment_schedules.sale_id
      AND ms.customer_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "Ops roles read all smartphone schedules" ON public.smartphone_repayment_schedules;
CREATE POLICY "Ops roles read all smartphone schedules"
ON public.smartphone_repayment_schedules
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'agent_ops')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

-- Rebuild the stored schedule for one sale and return its headline figures.
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
    'last_daily', COALESCE(v_last, 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.smartphone_rebuild_repayment_schedule(uuid, numeric, integer, date) FROM PUBLIC;

-- Today's (or any date's) scheduled daily deduction for a sale. NULL when the
-- sale has no reducing-balance schedule, so older plans keep their fixed amount.
CREATE OR REPLACE FUNCTION public.smartphone_plan_daily_for_date(
  p_sale_id uuid,
  p_date date DEFAULT current_date
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT s.daily_deduction
       FROM public.smartphone_repayment_schedules s
      WHERE s.sale_id = p_sale_id
        AND p_date BETWEEN s.period_start AND s.period_end
      ORDER BY s.month_index
      LIMIT 1),
    (SELECT s.daily_deduction
       FROM public.smartphone_repayment_schedules s
      WHERE s.sale_id = p_sale_id
        AND s.period_end < p_date
      ORDER BY s.month_index DESC
      LIMIT 1)
  )
$function$;

REVOKE ALL ON FUNCTION public.smartphone_plan_daily_for_date(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.smartphone_plan_daily_for_date(uuid, date) TO authenticated;

-- Application: price the advance on the reducing-balance schedule.
CREATE OR REPLACE FUNCTION public.agent_order_smartphone(p_catalog_id uuid, p_period_months integer)
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
  v_days integer;
  v_total numeric;
  v_daily numeric;
  v_eff_pct numeric;
  v_start date;
  v_sched jsonb;
  v_name text;
  v_phone text;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF COALESCE(p_period_months, 0) NOT IN (3, 6, 9, 12) THEN
    RAISE EXCEPTION 'Choose a repayment period of 3, 6, 9 or 12 months';
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

  -- Only a duplicate open application blocks a submission. Tenant portfolio,
  -- National ID and price ceiling are review inputs for Agent Ops, not gates.
  IF (v_elig->>'has_open_application')::boolean THEN
    RAISE EXCEPTION 'You already have an application in progress';
  END IF;

  v_start := current_date + 7;

  SELECT COALESCE(sum(total_due), 0), COALESCE(sum(days_in_period), 0)
    INTO v_total, v_days
  FROM public.smartphone_reducing_schedule(v_price, p_period_months, v_start);

  SELECT daily_deduction INTO v_daily
  FROM public.smartphone_reducing_schedule(v_price, p_period_months, v_start)
  ORDER BY month_index LIMIT 1;

  v_eff_pct := round((v_total - v_price) * 100 / v_price, 2);

  SELECT full_name, phone INTO v_name, v_phone FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, total_revenue, total_amount,
    client_name, client_phone, customer_id, created_by,
    payment_status, order_status, sale_date,
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
    'credit', 'pending_approval', current_date,
    v_cat.brand, v_cat.model_name,
    v_cat.id, v_cat.supplier_id,
    p_period_months, v_eff_pct, v_total,
    v_daily, v_days, 7,
    (v_elig->>'rank')::int, (v_elig->>'max_amount')::numeric, v_total - v_price,
    0, 0,
    'Smartphone advance application - ' || v_cat.brand || ' ' || COALESCE(v_cat.model_name, '')
      || ' over ' || p_period_months::text || ' months (reducing balance)'
  ) RETURNING id INTO v_id;

  v_sched := public.smartphone_rebuild_repayment_schedule(v_id, v_price, p_period_months, v_start);

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'smartphone_advance_requested', 'merchandise_sales', v_id,
            'Agent submitted a smartphone advance application for Agent Ops review',
            jsonb_build_object('price', v_price, 'total_repayable', v_total,
                               'period_months', p_period_months, 'first_daily', v_daily,
                               'schedule', v_sched,
                               'active_tenant_count', (v_elig->>'active_tenant_count')::int));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', v_id,
    'order_status', 'pending_approval',
    'total_repayable', v_total,
    'daily_amount', v_daily,
    'repayment_days', v_days,
    'period_months', p_period_months,
    'schedule', v_sched
  );
END;
$function$;

-- Review terms: rebuild the reducing-balance schedule instead of repricing at a
-- flat 33% regardless of the period the agent chose.
CREATE OR REPLACE FUNCTION public.smartphone_apply_review_terms(
  p_sale_id uuid,
  p_total_amount numeric,
  p_repayment_days integer,
  p_daily_deduction numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_amount numeric := NULLIF(p_total_amount, 0);
  v_days integer := NULLIF(p_repayment_days, 0);
  v_daily numeric := NULLIF(p_daily_deduction, 0);
  v_price numeric;
  v_months integer;
  v_start date;
  v_sched jsonb;
BEGIN
  IF v_amount IS NULL AND v_days IS NULL AND v_daily IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(v_amount, NULLIF(total_amount, 0), NULLIF(unit_price, 0), 0),
         COALESCE(advance_period_months, 12),
         COALESCE(repayment_starts_on, current_date + COALESCE(NULLIF(grace_days, 0), 7))
    INTO v_price, v_months, v_start
  FROM public.merchandise_sales WHERE id = p_sale_id;

  -- A reviewer-supplied day count may shorten/extend the period.
  IF v_days IS NOT NULL THEN
    v_months := CASE
      WHEN v_days <= 90 THEN 3
      WHEN v_days <= 180 THEN 6
      WHEN v_days <= 270 THEN 9
      ELSE 12
    END;
  END IF;

  v_sched := public.smartphone_rebuild_repayment_schedule(p_sale_id, v_price, v_months, v_start);

  UPDATE public.merchandise_sales
  SET total_amount = COALESCE(v_amount, total_amount),
      unit_price = COALESCE(v_amount, unit_price),
      advance_period_months = v_months,
      advance_markup_pct = CASE WHEN v_price > 0
                                THEN round((v_sched->>'total_charge')::numeric * 100 / v_price, 2)
                                ELSE advance_markup_pct END,
      access_repayment_days = COALESCE(NULLIF((v_sched->>'days')::integer, 0), v_days, access_repayment_days),
      total_repayable = COALESCE(NULLIF((v_sched->>'total_repayable')::numeric, 0), total_repayable),
      access_daily_amount = COALESCE(v_daily, NULLIF((v_sched->>'first_daily')::numeric, 0), access_daily_amount),
      payment_projection = COALESCE(NULLIF((v_sched->>'total_charge')::numeric, 0), payment_projection)
  WHERE id = p_sale_id;
END;
$function$;

-- Disbursement: anchor the schedule to the release date plus the grace period.
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

  v_months := COALESCE(v_sale.advance_period_months, 12);
  IF v_months NOT IN (3, 6, 9, 12) THEN
    v_months := 12;
  END IF;
  v_start := current_date + COALESCE(NULLIF(v_sale.grace_days, 0), 7);

  v_sched := public.smartphone_rebuild_repayment_schedule(p_sale_id, v_price, v_months, v_start);
  v_total := COALESCE(NULLIF((v_sched->>'total_repayable')::numeric, 0), NULLIF(v_sale.total_repayable, 0), v_price);
  v_daily := COALESCE(NULLIF((v_sched->>'first_daily')::numeric, 0), NULLIF(v_sale.access_daily_amount, 0), 0);
  v_days  := COALESCE(NULLIF((v_sched->>'days')::integer, 0), NULLIF(v_sale.access_repayment_days, 0), 365);

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
              || ' - first daily ' || to_char(v_daily, 'FM999,999,999')
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

-- Daily recovery: smartphone plans follow their stored reducing-balance
-- schedule; every other merchandise plan keeps its existing fixed amount.
CREATE OR REPLACE FUNCTION public.recover_merchandise_from_wallets()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plan            record;
  v_avail           numeric;
  v_amount          numeric;
  v_sched_daily     numeric;
  v_closing         numeric;
  v_ref             uuid;
  v_idem            text;
  v_desc            text;
  v_plans_touched   int := 0;
  v_recovered_total numeric := 0;
  v_failures        int := 0;
  v_skipped_grace   int := 0;
  v_last_error      text;
BEGIN
  FOR v_plan IN
    SELECT * FROM public.merchandise_recovery_plans
    WHERE status = 'active' AND outstanding_balance > 0
    ORDER BY created_at ASC
  LOOP
    -- Grace period (or whatever start date the plan carries)
    IF v_plan.starts_on IS NOT NULL AND v_plan.starts_on > current_date THEN
      v_skipped_grace := v_skipped_grace + 1;
      CONTINUE;
    END IF;

    v_avail := COALESCE(public.get_user_available_balance(v_plan.customer_id), 0);
    IF v_avail <= 0 THEN CONTINUE; END IF;

    v_sched_daily := NULL;
    IF v_plan.sale_id IS NOT NULL THEN
      v_sched_daily := NULLIF(public.smartphone_plan_daily_for_date(v_plan.sale_id, current_date), 0);
    END IF;

    v_amount := LEAST(
      v_plan.outstanding_balance,
      v_avail,
      GREATEST(
        round(COALESCE(
          v_sched_daily,
          NULLIF(v_plan.daily_deduction_amount, 0),
          COALESCE(v_plan.original_amount, v_plan.outstanding_balance) * COALESCE(v_plan.daily_rate, 0)
        )),
        1
      )
    );
    IF v_amount <= 0 THEN CONTINUE; END IF;

    v_ref  := gen_random_uuid();
    v_idem := 'merch_recover_' || v_plan.id::text || '_' || to_char(now(), 'YYYYMMDDHH24');
    v_desc := 'Merchandise Payment - ' || COALESCE(v_plan.item_name, 'Item') || ' (daily instalment)';

    BEGIN
      PERFORM public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', v_plan.customer_id,
            'ledger_scope', 'wallet',
            'direction', 'cash_out',
            'amount', v_amount,
            'category', 'agent_repayment',
            'recipient_type', 'user',
            'wallet_bucket', 'withdrawable',
            'source_table', 'merchandise_recovery_plans',
            'source_id', v_plan.id,
            'description', v_desc,
            'currency', 'UGX',
            'metadata', jsonb_build_object(
              'source', 'merchandise_daily_recovery',
              'plan_id', v_plan.id,
              'sale_id', v_plan.sale_id
            )
          ),
          jsonb_build_object(
            'user_id', v_plan.customer_id,
            'ledger_scope', 'platform',
            'direction', 'cash_in',
            'amount', v_amount,
            'category', 'agent_repayment',
            'recipient_type', 'operational_wallet',
            'source_table', 'merchandise_recovery_plans',
            'source_id', v_plan.id,
            'description', 'Merchandise cost recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Item'),
            'currency', 'UGX',
            'metadata', jsonb_build_object(
              'source', 'merchandise_daily_recovery',
              'plan_id', v_plan.id,
              'sale_id', v_plan.sale_id,
              'from_customer', v_plan.customer_id,
              'item_name', v_plan.item_name
            )
          )
        ),
        idempotency_key => v_idem
      );

      v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);

      INSERT INTO public.merchandise_recovery_deductions (
        plan_id, sale_id, customer_id, item_name, amount, outstanding_before, outstanding_after, ledger_reference
      ) VALUES (
        v_plan.id, v_plan.sale_id, v_plan.customer_id, v_plan.item_name,
        v_amount, v_plan.outstanding_balance, v_closing, v_ref
      );

      UPDATE public.merchandise_recovery_plans
      SET outstanding_balance = v_closing,
          amount_recovered = amount_recovered + v_amount,
          last_recovery_at = now(),
          status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
          completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END,
          updated_at = now()
      WHERE id = v_plan.id;

      IF v_plan.sale_id IS NOT NULL THEN
        UPDATE public.merchandise_sales
        SET amount_paid = COALESCE(amount_paid, 0) + v_amount,
            amount_outstanding = v_closing,
            payment_status = CASE WHEN v_closing <= 0 THEN 'paid' ELSE 'partial' END,
            updated_at = now()
        WHERE id = v_plan.sale_id;
      END IF;

      v_plans_touched := v_plans_touched + 1;
      v_recovered_total := v_recovered_total + v_amount;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures + 1;
      v_last_error := SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'plans_touched', v_plans_touched,
    'recovered_total', v_recovered_total,
    'skipped_grace', v_skipped_grace,
    'failures', v_failures,
    'last_error', v_last_error
  );
END;
$function$;