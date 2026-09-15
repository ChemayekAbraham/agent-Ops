-- Allow smartphone advance repayment periods from 1 to 12 months.
-- Previously only 3 / 6 / 9 / 12 months were accepted; agents can now pick any
-- whole-month period between 1 and 12.

-- Lookup helpers are kept in sync with the new range. They are not used by the
-- live order path today (it stores the computed effective percentage), but
-- tooling and rebuild fallbacks must support the full range.
CREATE OR REPLACE FUNCTION public.smartphone_period_days(p_months integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_months
    WHEN 1 THEN 30
    WHEN 2 THEN 60
    WHEN 3 THEN 90
    WHEN 4 THEN 120
    WHEN 5 THEN 150
    WHEN 6 THEN 180
    WHEN 7 THEN 210
    WHEN 8 THEN 240
    WHEN 9 THEN 270
    WHEN 10 THEN 300
    WHEN 11 THEN 330
    WHEN 12 THEN 365
    ELSE NULL
  END
$function$;

CREATE OR REPLACE FUNCTION public.smartphone_period_markup(p_months integer)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_months
    WHEN 1 THEN 31
    WHEN 2 THEN 32
    WHEN 3 THEN 33
    WHEN 4 THEN 34
    WHEN 5 THEN 35
    WHEN 6 THEN 36
    WHEN 7 THEN 37
    WHEN 8 THEN 38
    WHEN 9 THEN 39
    WHEN 10 THEN 40
    WHEN 11 THEN 41
    WHEN 12 THEN 42
    ELSE NULL
  END::numeric
$function$;

-- Core reducing-balance schedule generator now accepts any 1–12 month period.
CREATE OR REPLACE FUNCTION public.smartphone_reducing_schedule(p_amount numeric, p_months integer, p_start date DEFAULT CURRENT_DATE)
 RETURNS TABLE(month_index integer, period_start date, period_end date, days_in_period integer, opening_principal numeric, principal_due numeric, charge_due numeric, total_due numeric, daily_deduction numeric)
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
  IF v_months NOT BETWEEN 1 AND 12 THEN
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

-- Order submission validation now allows 1–12 months.
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

  IF COALESCE(p_period_months, 0) NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'Choose a repayment period of 1 to 12 months';
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

-- Schedule rebuild used on order creation and recovery now accepts 1–12 months.
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
