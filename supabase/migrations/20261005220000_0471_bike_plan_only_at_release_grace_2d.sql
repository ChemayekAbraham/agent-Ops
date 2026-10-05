CREATE OR REPLACE FUNCTION public.create_merchandise_recovery_plan()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_customer uuid;
  v_name text;
  v_rate numeric;
  v_item text;
BEGIN
  IF COALESCE(NEW.amount_outstanding, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  -- Bike leases get their recovery plan only when the CFO releases the money (cfo_disburse_bike_lease).
  IF lower(COALESCE(NEW.item_name,'')) LIKE '%spiro%'
     OR public.agent_product_category(NEW.item_name) = 'motor_bike' THEN
    RETURN NEW;
  END IF;

  v_customer := NEW.customer_id;
  IF v_customer IS NULL AND NEW.client_phone IS NOT NULL
     AND public.normalize_phone_9(NEW.client_phone) <> '' THEN
    SELECT id INTO v_customer
    FROM public.profiles
    WHERE public.normalize_phone_9(phone) = public.normalize_phone_9(NEW.client_phone)
    LIMIT 1;
  END IF;

  IF v_customer IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  v_item := lower(COALESCE(NEW.item_name, ''));
  IF v_item LIKE '%phone%' OR v_item LIKE '%bike%' THEN
    v_rate := 0.33;
  ELSE
    v_rate := CASE WHEN COALESCE(NEW.payment_plan, 'full') = 'installment' THEN 0.25 ELSE 0.15 END;
  END IF;

  INSERT INTO public.merchandise_recovery_plans (
    sale_id, customer_id, customer_name, customer_phone, item_name,
    original_amount, outstanding_balance, daily_rate, created_by
  ) VALUES (
    NEW.id, v_customer, COALESCE(v_name, NEW.client_name), NEW.client_phone, NEW.item_name,
    NEW.amount_outstanding, NEW.amount_outstanding, v_rate, NEW.created_by
  );

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cfo_disburse_bike_lease(p_sale_id uuid, p_valuation numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_valuation numeric;
  v_recover numeric;
  v_term integer;
  v_projection numeric;
  v_fee numeric;
  v_total numeric;
  v_customer uuid;
  v_name text;
  v_ref text;
  v_group uuid;
BEGIN

  IF auth.uid() IS NOT NULL AND NOT public.is_cfo_approver(auth.uid()) THEN
    RAISE EXCEPTION 'This request could not be completed';
  END IF;
  IF NOT public.can_cfo_disburse_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to release Spiro bikes';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'coo_approved' THEN
    RAISE EXCEPTION 'Application must be COO approved before disbursement (currently %)', COALESCE(v_sale.order_status, 'submitted');
  END IF;

  v_customer := v_sale.customer_id;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'Application has no linked agent account';
  END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  -- Always the COO-approved price; any price the CFO sends (p_valuation) is ignored.
  v_valuation := COALESCE(NULLIF(v_sale.valuation_amount, 0), NULLIF(v_sale.total_amount, 0), v_sale.total_revenue, 0);
  IF v_valuation <= 0 THEN
    RAISE EXCEPTION 'Bike valuation must be greater than zero';
  END IF;
  -- No payments may exist before release; refuse and say what was found.
  IF COALESCE(v_sale.amount_paid, 0) > 0
     OR EXISTS (SELECT 1 FROM public.merchandise_recovery_plans p
                WHERE p.sale_id = p_sale_id AND (COALESCE(p.amount_recovered,0) > 0
                  OR EXISTS (SELECT 1 FROM public.merchandise_recovery_deductions d WHERE d.plan_id = p.id))) THEN
    RAISE EXCEPTION 'Release blocked: this bike lease already has payments recorded before release (UGX %). Resolve them first.',
      to_char(GREATEST(COALESCE(v_sale.amount_paid,0), COALESCE((SELECT sum(amount_recovered) FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id),0)), 'FM999,999,999,990.##');
  END IF;
  v_recover := v_valuation;
  IF v_recover <= 0 THEN
    RAISE EXCEPTION 'Lease has no amount to recover';
  END IF;
  v_term := GREATEST(COALESCE(v_sale.lease_term_months, 12), 1);
  v_projection := (SELECT m.daily FROM public._spiro_lease_month(v_valuation, v_term, 1) m);
  -- Bike price + 28% monthly fee on the principal still owed (matches src/lib/spiroBikeLease.ts).
  v_fee := public._spiro_lease_fee_total(v_valuation, v_term);
  v_total := v_recover + v_fee;

  v_ref := 'bike-lease-disbursement-' || p_sale_id::text;

  IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_ref) THEN
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_customer, 'amount', v_valuation, 'direction', 'cash_in',
          'category', 'agent_advance_credit', 'ledger_scope', 'wallet', 'recipient_type', 'user',
          'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_ref, 'currency', 'UGX',
          'description', 'Bike lease disbursement to ' || COALESCE(v_name, 'agent'),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_uid, 'amount', v_valuation, 'direction', 'cash_out',
          'category', 'equipment_expense', 'ledger_scope', 'platform',
          'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_ref, 'currency', 'UGX',
          'description', 'Bike lease funded for ' || COALESCE(v_name, 'agent'),
          'transaction_date', now()
        )
      ),
      v_ref
    );
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      valuation_amount = v_valuation,
      total_amount = v_valuation,
      total_revenue = v_valuation,
      unit_price = v_valuation / GREATEST(COALESCE(quantity, 1), 1),
      amount_outstanding = v_total,
      payment_projection = v_projection,
      lease_daily_rate = NULL,
      payment_status = 'credit',
      cfo_disbursed_by = v_uid,
      cfo_disbursed_at = now(),
      disbursed_amount = v_valuation,
      disbursement_group_id = COALESCE(v_group, disbursement_group_id),
      lease_activated_at = now(),
      notes = COALESCE(notes, '') || ' | CFO disbursed to the agent wallet and activated the lease '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' at valuation ' || to_char(v_valuation, 'FM999,999,999')
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  -- Bikes never use daily_rate (always 0); recovery uses the bike schedule only.
  IF NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id) THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, daily_rate, created_by,
      pricing_basis, fee_total, principal_total, is_bike_lease
    ) VALUES (
      p_sale_id, v_customer, COALESCE(v_name, v_sale.client_name), v_sale.client_phone,
      COALESCE(v_sale.item_name, 'Welile Spiro Bike'), v_total, v_total, 0, v_uid,
      'spiro_28pct_v2', v_fee, v_recover, true
    );
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET original_amount = v_total,
        outstanding_balance = v_total,
        is_bike_lease = true,
        daily_rate = 0,
        pricing_basis = 'spiro_28pct_v2',
        fee_total = v_fee,
        principal_total = v_recover,
        fee_recovered = 0,
        principal_recovered = 0,
        status = 'active',
        completed_at = NULL,
        recovery_started_on = NULL, due_accrued_through = NULL, due_balance = 0, term_end_on = NULL,
        last_success_on = NULL, last_attempt_on = NULL, last_attempt_result = NULL,
        daily_amount_fixed = NULL, miss_alert_sent = false
    WHERE sale_id = p_sale_id AND status <> 'cancelled';
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_cfo_disbursed', 'merchandise_sales', p_sale_id,
            'CFO disbursed the bike funds to the ordering agent wallet and activated the recovery lease',
            jsonb_build_object('valuation', v_valuation, 'cfo_sent_valuation_ignored', p_valuation,
                               'recovery_amount', v_total, 'principal', v_recover, 'access_fee', v_fee,
                               'monthly_rate_pct', 28, 'lease_term_months', v_term,
                               'credited_agent_id', v_customer, 'reference_id', v_ref));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'valuation', v_valuation,
    'recovery_amount', v_total,
    'principal', v_recover,
    'access_fee', v_fee,
    'daily_recovery', v_projection,
    'monthly_rate_pct', 28,
    'lease_term_months', v_term,
    'credited_agent_id', v_customer,
    'disbursement_group_id', v_group
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._merch_bike_day(p_sale_id uuid, p_v2 boolean, p_day date)
 RETURNS TABLE(daily numeric, fee_ratio numeric, term_end date, active boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE l record; a date; m int; inst numeric; fee numeric; ver int; mx int;
BEGIN
  SELECT id, lease_activated_at, valuation_amount, GREATEST(COALESCE(lease_term_months,12),1) AS term
    INTO l FROM public.agent_bike_leases WHERE sale_id = p_sale_id;
  IF l.id IS NULL OR l.lease_activated_at IS NULL THEN active := false; RETURN NEXT; RETURN; END IF;
  -- First collection day = release day + 2 (Kampala). Month 1 starts there.
  a := (l.lease_activated_at AT TIME ZONE 'Africa/Kampala')::date + 2;
  term_end := (a + make_interval(months => l.term))::date;
  IF p_day < a THEN active := false; RETURN NEXT; RETURN; END IF;
  active := true;
  m := LEAST((extract(year FROM age(p_day, a)) * 12 + extract(month FROM age(p_day, a)))::int + 1, l.term);
  IF p_v2 THEN
    SELECT x.total_due, x.fee_due INTO inst, fee FROM public._spiro_lease_month(l.valuation_amount, l.term, m) x;
    fee_ratio := CASE WHEN COALESCE(inst,0) > 0 THEN fee / inst ELSE 0 END;
  ELSE
    SELECT max(version) INTO ver FROM public.agent_bike_lease_schedules WHERE lease_id = l.id;
    SELECT max(installment_no) INTO mx FROM public.agent_bike_lease_schedules WHERE lease_id = l.id AND version = ver;
    SELECT installment_amount INTO inst FROM public.agent_bike_lease_schedules
      WHERE lease_id = l.id AND version = ver AND installment_no = LEAST(m, COALESCE(mx, 1));
    fee_ratio := 0;
  END IF;
  daily := GREATEST(round(COALESCE(inst,0) / public._spiro_month_days(a, m)), 0);
  RETURN NEXT;
END $function$;

CREATE OR REPLACE FUNCTION public._generate_bike_lease_schedule(p_lease_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_rate CONSTANT numeric := 0.28;
  l public.agent_bike_leases;
  v_ver integer;
  n integer; bal numeric; per numeric; intr numeric; prin numeric;
  v_start date; i integer;
BEGIN
  SELECT * INTO l FROM public.agent_bike_leases WHERE id = p_lease_id;
  IF l.id IS NULL OR COALESCE(l.valuation_amount,0) <= 0 THEN RETURN 0; END IF;
  SELECT COALESCE(max(version),0)+1 INTO v_ver FROM public.agent_bike_lease_schedules WHERE lease_id = p_lease_id;
  n := GREATEST(l.lease_term_months,1);
  bal := l.valuation_amount;
  per := ceil(bal / n);
  v_start := (COALESCE(l.lease_activated_at, l.coo_approved_at, l.created_at, now()) AT TIME ZONE 'Africa/Kampala')::date
    + CASE WHEN l.lease_activated_at IS NOT NULL THEN 2 ELSE 0 END;
  FOR i IN 1..n LOOP
    intr := round(bal * c_rate);
    prin := CASE WHEN i = n THEN bal ELSE LEAST(per, bal) END;
    INSERT INTO public.agent_bike_lease_schedules(lease_id, version, installment_no, due_date, opening_balance,
      principal_due, interest_due, installment_amount, closing_balance, monthly_rate_pct, created_by)
    VALUES (p_lease_id, v_ver, i, (v_start + make_interval(months => i))::date, bal,
      prin, intr, prin + intr, bal - prin, 28, auth.uid());
    bal := bal - prin;
  END LOOP;
  RETURN v_ver;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_block_bike_payment_before_release()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM public.merchandise_recovery_plans p
             JOIN public.agent_bike_leases b ON b.sale_id = p.sale_id
             JOIN public.merchandise_sales s ON s.id = p.sale_id
             WHERE p.id = NEW.plan_id AND (s.cfo_disbursed_at IS NULL OR s.lease_activated_at IS NULL)) THEN
    RAISE EXCEPTION 'Bike lease not released yet: no payment may be collected or recorded before release';
  END IF;
  RETURN NEW;
END $f$;

DROP TRIGGER IF EXISTS trg_block_bike_payment_before_release ON public.merchandise_recovery_deductions;
CREATE TRIGGER trg_block_bike_payment_before_release BEFORE INSERT ON public.merchandise_recovery_deductions
  FOR EACH ROW EXECUTE FUNCTION public.trg_block_bike_payment_before_release();