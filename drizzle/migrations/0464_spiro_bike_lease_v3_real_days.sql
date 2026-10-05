-- Spiro bike lease v3: daily = month due / real days in that repayment month (Kampala);
-- exact monthly principal (price / months). Matches src/lib/spiroBikeLease.ts.
-- Rollback: docs/rollbacks/spiro_bike_lease_v2_rollback.sql (section A = undo v3 only, section B = undo everything).

CREATE OR REPLACE FUNCTION public._spiro_month_days(p_start date, p_month integer)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT GREATEST(1, ((p_start + make_interval(months => GREATEST(p_month,1)))::date
                    - (p_start + make_interval(months => GREATEST(p_month,1) - 1))::date))
$$;

CREATE OR REPLACE FUNCTION public._spiro_lease_month(p_base numeric, p_term integer, p_month integer)
RETURNS TABLE(opening_principal numeric, principal_due numeric, fee_due numeric, total_due numeric, daily numeric)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE n int := LEAST(GREATEST(COALESCE(p_term,1),1),24); base numeric := GREATEST(round(COALESCE(p_base,0)),0);
  k int := LEAST(GREATEST(p_month,1), LEAST(GREATEST(COALESCE(p_term,1),1),24));
BEGIN
  -- Exact slice base/n (not rounded up). Fee = 28% of principal still owed at the start of the month.
  opening_principal := base * (n - k + 1) / n;
  principal_due := base / n;
  fee_due := opening_principal * 0.28;
  total_due := principal_due + fee_due;
  -- Quote for a lease starting today (Kampala). Live recovery uses the lease's own start date.
  daily := round(total_due / public._spiro_month_days((now() AT TIME ZONE 'Africa/Kampala')::date, k));
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION public._spiro_lease_fee_total(p_base numeric, p_term integer)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT round(GREATEST(round(COALESCE(p_base,0)),0) * 0.28 * (LEAST(GREATEST(COALESCE(p_term,1),1),24) + 1) / 2.0)
$$;

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
  v_lease_id        uuid;
  v_activated       timestamptz;
  v_today           date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_act_date        date;
  v_month           int;
  v_ver             int;
  v_max_no          int;
  v_inst            numeric;
  v_bike_cap        numeric;
  v_v2              boolean;
  v_val             numeric;
  v_term            int;
  v_fee_m           numeric;
  v_fee_part        numeric;
  v_prin_part       numeric;
  v_fee_left        numeric;
  v_prin_left       numeric;
  v_entries         jsonb;
BEGIN
  FOR v_plan IN
    SELECT * FROM public.merchandise_recovery_plans
    WHERE status = 'active' AND outstanding_balance > 0
    ORDER BY created_at ASC
  LOOP
    IF v_plan.starts_on IS NOT NULL AND v_plan.starts_on > current_date THEN
      v_skipped_grace := v_skipped_grace + 1;
      CONTINUE;
    END IF;

    v_lease_id := NULL; v_activated := NULL; v_bike_cap := NULL; v_v2 := false; v_fee_m := NULL;
    IF v_plan.sale_id IS NOT NULL THEN
      SELECT id, lease_activated_at, valuation_amount, GREATEST(COALESCE(lease_term_months,12),1)
        INTO v_lease_id, v_activated, v_val, v_term
      FROM public.agent_bike_leases WHERE sale_id = v_plan.sale_id;
    END IF;

    IF v_lease_id IS NOT NULL THEN
      IF v_activated IS NULL THEN CONTINUE; END IF;
      v_v2 := COALESCE(v_plan.pricing_basis, '') = 'spiro_28pct_v2';
      -- New-pricing bike plans collect at most once per Kampala day.
      IF v_v2 AND v_plan.last_bike_recovery_on IS NOT NULL AND v_plan.last_bike_recovery_on >= v_today THEN CONTINUE; END IF;
      v_act_date := (v_activated AT TIME ZONE 'Africa/Kampala')::date;
      IF v_act_date > v_today THEN CONTINUE; END IF;
      v_month := (extract(year FROM age(v_today, v_act_date)) * 12
                  + extract(month FROM age(v_today, v_act_date)))::int + 1;
      IF v_v2 THEN
        SELECT m.total_due, m.fee_due INTO v_inst, v_fee_m
        FROM public._spiro_lease_month(v_val, v_term, LEAST(v_month, v_term)) m;
        IF COALESCE(v_inst, 0) <= 0 THEN CONTINUE; END IF;
        -- Daily = this month's amount due / real days in this repayment month (Kampala calendar).
        v_bike_cap := GREATEST(round(v_inst / public._spiro_month_days(v_act_date, v_month)), 1);
      ELSE
        SELECT max(version) INTO v_ver FROM public.agent_bike_lease_schedules WHERE lease_id = v_lease_id;
        IF v_ver IS NULL THEN CONTINUE; END IF;
        SELECT max(installment_no) INTO v_max_no FROM public.agent_bike_lease_schedules
        WHERE lease_id = v_lease_id AND version = v_ver;
        SELECT installment_amount INTO v_inst FROM public.agent_bike_lease_schedules
        WHERE lease_id = v_lease_id AND version = v_ver AND installment_no = LEAST(v_month, v_max_no);
        IF COALESCE(v_inst, 0) <= 0 THEN CONTINUE; END IF;
        v_bike_cap := GREATEST(round(v_inst / 30.0), 1);
      END IF;
    END IF;

    v_avail := COALESCE(public.get_user_available_balance(v_plan.customer_id), 0);
    IF v_avail <= 0 THEN CONTINUE; END IF;

    IF v_bike_cap IS NOT NULL THEN
      v_amount := LEAST(v_plan.outstanding_balance, v_avail, v_bike_cap);
    ELSE
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
    END IF;
    IF v_amount <= 0 THEN CONTINUE; END IF;

    v_ref  := gen_random_uuid();
    IF v_v2 THEN
      v_idem := 'bike_recover_' || v_plan.id::text || '_' || to_char(v_today, 'YYYYMMDD');
    ELSE
      v_idem := 'merch_recover_' || v_plan.id::text || '_' || to_char(now(), 'YYYYMMDDHH24');
    END IF;
    v_desc := 'Merchandise Payment - ' || COALESCE(v_plan.item_name, 'Item') || ' (daily instalment)';

    IF v_v2 THEN
      BEGIN
        v_fee_left  := GREATEST(COALESCE(v_plan.fee_total,0) - COALESCE(v_plan.fee_recovered,0), 0);
        v_prin_left := GREATEST(COALESCE(v_plan.principal_total,0) - COALESCE(v_plan.principal_recovered,0), 0);
        v_fee_part  := LEAST(round(v_amount * v_fee_m / v_inst), v_fee_left);
        v_prin_part := v_amount - v_fee_part;
        IF v_prin_part > v_prin_left THEN
          v_fee_part  := LEAST(v_fee_part + (v_prin_part - v_prin_left), v_fee_left);
          v_prin_part := v_amount - v_fee_part;
        END IF;

        v_entries := jsonb_build_array(jsonb_build_object(
          'user_id', v_plan.customer_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user',
          'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_recovery_plans',
          'source_id', v_plan.id, 'description', v_desc, 'currency', 'UGX',
          'metadata', jsonb_build_object('source', 'merchandise_daily_recovery', 'plan_id', v_plan.id,
            'sale_id', v_plan.sale_id, 'kampala_day', v_today, 'principal_part', v_prin_part, 'fee_part', v_fee_part)));
        IF v_prin_part > 0 THEN
          v_entries := v_entries || jsonb_build_array(jsonb_build_object(
            'user_id', v_plan.customer_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', v_prin_part, 'category', 'bike_recovery_repayment', 'recipient_type', 'operational_wallet',
            'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id,
            'description', 'Bike lease principal recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Item'),
            'currency', 'UGX',
            'metadata', jsonb_build_object('source', 'merchandise_daily_recovery', 'plan_id', v_plan.id,
              'sale_id', v_plan.sale_id, 'from_customer', v_plan.customer_id, 'item_name', v_plan.item_name, 'part', 'principal')));
        END IF;
        IF v_fee_part > 0 THEN
          v_entries := v_entries || jsonb_build_array(jsonb_build_object(
            'user_id', v_plan.customer_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', v_fee_part, 'category', 'access_fee_collected', 'recipient_type', 'operational_wallet',
            'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id,
            'description', 'Bike lease access fee collected: ' || COALESCE(v_plan.item_name, 'Item'),
            'currency', 'UGX',
            'metadata', jsonb_build_object('source', 'bike_lease_access_fee', 'plan_id', v_plan.id,
              'sale_id', v_plan.sale_id, 'from_customer', v_plan.customer_id, 'item_name', v_plan.item_name, 'part', 'access_fee')));
        END IF;

        PERFORM public.create_ledger_transaction(entries => v_entries, idempotency_key => v_idem);

        v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);

        INSERT INTO public.merchandise_recovery_deductions (
          plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref
        ) VALUES (
          v_plan.id, v_plan.customer_id, v_plan.item_name, v_amount, v_avail, v_closing, v_ref
        );

        UPDATE public.merchandise_recovery_plans
        SET outstanding_balance = v_closing,
            amount_recovered = amount_recovered + v_amount,
            fee_recovered = COALESCE(fee_recovered, 0) + v_fee_part,
            principal_recovered = COALESCE(principal_recovered, 0) + v_prin_part,
            last_bike_recovery_on = v_today,
            last_recovery_at = now(),
            status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
            completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END,
            updated_at = now()
        WHERE id = v_plan.id;

        UPDATE public.merchandise_sales
        SET amount_paid = COALESCE(amount_paid, 0) + v_amount,
            amount_outstanding = v_closing,
            payment_status = CASE WHEN v_closing <= 0 THEN 'paid' ELSE 'partial' END,
            updated_at = now()
        WHERE id = v_plan.sale_id;

        v_plans_touched := v_plans_touched + 1;
        v_recovered_total := v_recovered_total + v_amount;
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures + 1;
        v_last_error := SQLERRM;
      END;
      CONTINUE;
    END IF;

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
            'category', CASE WHEN COALESCE(v_plan.item_name, '') ILIKE '%bike%' THEN 'bike_recovery_repayment' ELSE 'merchandise_recovery_repayment' END,
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

-- Self-test: 100,000 / 12 months must give fees 182,000 and total 282,000 when collected day by day
-- with real month lengths (start 31 Jan to hit short months), or this whole migration rolls back.
DO $t$
DECLARE base numeric := 100000; n int := 12; day0 date := date '2026-01-31'; d date := date '2026-01-31';
  outstanding numeric; fee_total numeric; fee_rec numeric := 0; prin_rec numeric := 0;
  m int; inst numeric; feem numeric; cap numeric; amt numeric; fp numeric; pp numeric; fl numeric; pl numeric;
  total numeric := 0; guard int := 0;
BEGIN
  fee_total := public._spiro_lease_fee_total(base, n);
  outstanding := base + fee_total;
  IF fee_total <> 182000 OR outstanding <> 282000 OR public._spiro_lease_fee_total(159600, 12) <> 290472 THEN
    RAISE EXCEPTION 'SPIRO V3 TEST FAIL: fee %, total %', fee_total, outstanding;
  END IF;
  IF (SELECT round(sum(fee_due)) FROM generate_series(1,12) g(i), public._spiro_lease_month(base, n, g.i)) <> 182000 THEN
    RAISE EXCEPTION 'SPIRO V3 TEST FAIL: monthly fees do not sum to 182,000';
  END IF;
  IF public._spiro_month_days(date '2026-01-31', 1) <> 28 OR public._spiro_month_days(date '2026-03-05', 1) <> 31 THEN
    RAISE EXCEPTION 'SPIRO V3 TEST FAIL: month length';
  END IF;
  WHILE outstanding > 0 LOOP
    guard := guard + 1; IF guard > 2000 THEN RAISE EXCEPTION 'SPIRO V3 TEST FAIL: never cleared'; END IF;
    m := (extract(year FROM age(d, day0)) * 12 + extract(month FROM age(d, day0)))::int + 1;
    SELECT total_due, fee_due INTO inst, feem FROM public._spiro_lease_month(base, n, LEAST(m, n));
    cap := GREATEST(round(inst / public._spiro_month_days(day0, m)), 1);
    amt := LEAST(outstanding, cap);
    fl := fee_total - fee_rec; pl := base - prin_rec;
    fp := LEAST(round(amt * feem / inst), fl); pp := amt - fp;
    IF pp > pl THEN fp := LEAST(fp + (pp - pl), fl); pp := amt - fp; END IF;
    fee_rec := fee_rec + fp; prin_rec := prin_rec + pp; outstanding := outstanding - amt; total := total + amt;
    d := d + 1;
  END LOOP;
  IF total <> 282000 OR fee_rec <> 182000 OR prin_rec <> 100000 THEN
    RAISE EXCEPTION 'SPIRO V3 TEST FAIL: collected %, fee %, principal %', total, fee_rec, prin_rec;
  END IF;
  IF (SELECT count(*) FROM public.merchandise_recovery_plans WHERE pricing_basis = 'spiro_28pct_v2') <> 0 THEN
    RAISE EXCEPTION 'SPIRO V3 ABORT: a lease was already released on the previous rule';
  END IF;
  RAISE NOTICE 'SPIRO V3 TEST PASSED: % collected over % days', total, guard;
END $t$;