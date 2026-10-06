-- ROLLBACK for Spiro bike lease pricing changes.
-- SECTION A: undo v3 only (real-days daily, exact principal) -> back to v2 (0463), captured live 2026-10-05T12:17:29Z.
-- SECTION B: undo everything -> original functions before 0463. Run A then B for a full rollback.
-- Added columns and helper functions are additive and harmless; leave them.

-- ===== SECTION A =====
BEGIN;
CREATE OR REPLACE FUNCTION public._spiro_lease_fee_total(p_base numeric, p_term integer)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(m.fee_due),0) FROM generate_series(1, LEAST(GREATEST(COALESCE(p_term,1),1),24)) g(i)
  CROSS JOIN LATERAL public._spiro_lease_month(p_base, p_term, g.i) m
$function$
;

CREATE OR REPLACE FUNCTION public._spiro_lease_month(p_base numeric, p_term integer, p_month integer)
 RETURNS TABLE(opening_principal numeric, principal_due numeric, fee_due numeric, total_due numeric, daily numeric)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE n int := LEAST(GREATEST(COALESCE(p_term,1),1),24); bal numeric := GREATEST(round(COALESCE(p_base,0)),0);
  per numeric; i int; prin numeric; fee numeric;
BEGIN
  per := ceil(bal / n);
  FOR i IN 1..n LOOP
    prin := CASE WHEN i = n THEN bal ELSE LEAST(per, bal) END;
    fee := round(bal * 0.28);
    IF i = LEAST(GREATEST(p_month,1), n) THEN
      opening_principal := bal; principal_due := prin; fee_due := fee; total_due := prin + fee;
      daily := round((prin + fee) / 30.0); RETURN NEXT; RETURN;
    END IF;
    bal := bal - prin;
  END LOOP;
END $function$
;

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

  v_valuation := COALESCE(NULLIF(p_valuation, 0), v_sale.valuation_amount, v_sale.total_amount, v_sale.total_revenue, 0);
  IF v_valuation <= 0 THEN
    RAISE EXCEPTION 'Bike valuation must be greater than zero';
  END IF;
  v_recover := GREATEST(v_valuation - COALESCE(v_sale.amount_paid, 0), 0);
  IF v_recover <= 0 THEN
    RAISE EXCEPTION 'Lease has no amount to recover';
  END IF;
  v_term := GREATEST(COALESCE(v_sale.lease_term_months, 12), 1);
  v_projection := (SELECT m.daily FROM public._spiro_lease_month(v_valuation, v_term, 1) m);
  -- Bike price + 28% monthly fee on the principal still owed (matches src/lib/spiroBikeLease.ts).
  v_fee := public._spiro_lease_fee_total(v_valuation, v_term);
  v_total := v_recover + v_fee;

  -- Money goes to the ordering agent's own wallet. Idempotent on reference.
  v_ref := 'bike-lease-disbursement-' || p_sale_id::text;

  IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_ref) THEN
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_customer,
          'amount', v_valuation,
          'direction', 'cash_in',
          'category', 'agent_advance_credit',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_sales',
          'source_id', p_sale_id,
          'reference_id', v_ref,
          'currency', 'UGX',
          'description', 'Bike lease disbursement to ' || COALESCE(v_name, 'agent'),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_uid,
          'amount', v_valuation,
          'direction', 'cash_out',
          'category', 'equipment_expense',
          'ledger_scope', 'platform',
          'source_table', 'merchandise_sales',
          'source_id', p_sale_id,
          'reference_id', v_ref,
          'currency', 'UGX',
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

  -- daily_rate is 0 for bikes: recovery uses the 28% reducing-balance month / 30.
  IF NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id) THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, daily_rate, created_by,
      pricing_basis, fee_total, principal_total
    ) VALUES (
      p_sale_id, v_customer, COALESCE(v_name, v_sale.client_name), v_sale.client_phone,
      COALESCE(v_sale.item_name, 'Welile Spiro Bike'), v_total, v_total, 0, v_uid,
      'spiro_28pct_v2', v_fee, v_recover
    );
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET original_amount = v_total,
        outstanding_balance = GREATEST(v_total - COALESCE(amount_recovered, 0), 0),
        daily_rate = 0,
        pricing_basis = 'spiro_28pct_v2',
        fee_total = v_fee,
        principal_total = v_recover,
        fee_recovered = 0,
        principal_recovered = COALESCE(amount_recovered, 0)
    WHERE sale_id = p_sale_id AND status = 'active';
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_cfo_disbursed', 'merchandise_sales', p_sale_id,
            'CFO disbursed the bike funds to the ordering agent wallet and activated the recovery lease',
            jsonb_build_object('valuation', v_valuation, 'recovery_amount', v_total,
                               'principal', v_recover, 'access_fee', v_fee,
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
$function$
;

CREATE OR REPLACE FUNCTION public.coo_approve_bike_lease(p_sale_id uuid, p_valuation numeric DEFAULT NULL::numeric, p_lease_term_months integer DEFAULT NULL::integer, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_valuation numeric;
  v_term integer;
  v_projection numeric;
  v_fee numeric;
BEGIN
  IF NOT public.can_coo_approve_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to approve Spiro bike lease applications';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') IN ('submitted','pending_approval') THEN
    RAISE EXCEPTION 'Agent Ops must verify this application before the COO can approve it';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'ops_approved' THEN
    RAISE EXCEPTION 'Application is already %', COALESCE(v_sale.order_status, 'submitted');
  END IF;
  IF v_sale.customer_id IS NULL THEN
    RAISE EXCEPTION 'Application has no linked agent account';
  END IF;

  v_valuation := COALESCE(NULLIF(p_valuation, 0), v_sale.valuation_amount, v_sale.total_amount, v_sale.total_revenue, 0);
  IF v_valuation <= 0 THEN
    RAISE EXCEPTION 'Approved bike valuation must be greater than zero';
  END IF;
  v_term := GREATEST(COALESCE(NULLIF(p_lease_term_months, 0), v_sale.lease_term_months, 12), 1);
  v_projection := (SELECT m.daily FROM public._spiro_lease_month(v_valuation, v_term, 1) m);
  v_fee := public._spiro_lease_fee_total(v_valuation, v_term);

  UPDATE public.merchandise_sales
  SET order_status = 'coo_approved',
      valuation_amount = v_valuation,
      total_amount = v_valuation,
      total_revenue = v_valuation,
      unit_price = v_valuation / GREATEST(COALESCE(quantity, 1), 1),
      lease_term_months = v_term,
      lease_daily_rate = NULL,
      payment_projection = v_projection,
      payment_status = 'credit',
      coo_approved_by = v_uid,
      coo_approved_at = now(),
      notes = COALESCE(notes, '') || ' | COO approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' at valuation ' || to_char(v_valuation, 'FM999,999,999')
              || ' over ' || v_term || ' months - forwarded to CFO for disbursement'
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_coo_approved', 'merchandise_sales', p_sale_id,
            'COO approved the Spiro bike lease valuation and forwarded it to the CFO for disbursement',
            jsonb_build_object('valuation', v_valuation, 'lease_term_months', v_term,
                               'daily_recovery', v_projection, 'monthly_rate_pct', 28,
                               'access_fee', v_fee, 'total_repayable', v_valuation + v_fee));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'coo_approved',
    'valuation', v_valuation,
    'lease_term_months', v_term,
    'daily_recovery', v_projection,
    'access_fee', v_fee,
    'total_repayable', v_valuation + v_fee
  );
END;
$function$
;

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
    -- Grace period (or whatever start date the plan carries)
    IF v_plan.starts_on IS NOT NULL AND v_plan.starts_on > current_date THEN
      v_skipped_grace := v_skipped_grace + 1;
      CONTINUE;
    END IF;

    -- Bike leases: daily cap = current month's instalment / 30 (28% reducing balance).
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
        v_bike_cap := GREATEST(round(v_inst / 30.0), 1);
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
        -- Split each collection into access-fee income and principal.
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
$function$
;

COMMIT;

-- ===== SECTION B =====
BEGIN;
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

  v_valuation := COALESCE(NULLIF(p_valuation, 0), v_sale.valuation_amount, v_sale.total_amount, v_sale.total_revenue, 0);
  IF v_valuation <= 0 THEN
    RAISE EXCEPTION 'Bike valuation must be greater than zero';
  END IF;
  v_recover := GREATEST(v_valuation - COALESCE(v_sale.amount_paid, 0), 0);
  IF v_recover <= 0 THEN
    RAISE EXCEPTION 'Lease has no amount to recover';
  END IF;
  v_term := GREATEST(COALESCE(v_sale.lease_term_months, 12), 1);
  v_projection := round((ceil(v_valuation / v_term) + round(v_valuation * 0.28)) / 30.0);

  -- Money goes to the ordering agent's own wallet. Idempotent on reference.
  v_ref := 'bike-lease-disbursement-' || p_sale_id::text;

  IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_ref) THEN
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_customer,
          'amount', v_valuation,
          'direction', 'cash_in',
          'category', 'agent_advance_credit',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_sales',
          'source_id', p_sale_id,
          'reference_id', v_ref,
          'currency', 'UGX',
          'description', 'Bike lease disbursement to ' || COALESCE(v_name, 'agent'),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_uid,
          'amount', v_valuation,
          'direction', 'cash_out',
          'category', 'equipment_expense',
          'ledger_scope', 'platform',
          'source_table', 'merchandise_sales',
          'source_id', p_sale_id,
          'reference_id', v_ref,
          'currency', 'UGX',
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
      amount_outstanding = v_recover,
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

  -- daily_rate is 0 for bikes: recovery reads the schedule instalment / 30.
  IF NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id) THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, daily_rate, created_by
    ) VALUES (
      p_sale_id, v_customer, COALESCE(v_name, v_sale.client_name), v_sale.client_phone,
      COALESCE(v_sale.item_name, 'Welile Spiro Bike'), v_recover, v_recover, 0, v_uid
    );
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET original_amount = v_recover,
        outstanding_balance = GREATEST(v_recover - COALESCE(amount_recovered, 0), 0),
        daily_rate = 0
    WHERE sale_id = p_sale_id AND status = 'active';
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_cfo_disbursed', 'merchandise_sales', p_sale_id,
            'CFO disbursed the bike funds to the ordering agent wallet and activated the recovery lease',
            jsonb_build_object('valuation', v_valuation, 'recovery_amount', v_recover,
                               'monthly_rate_pct', 28, 'lease_term_months', v_term,
                               'credited_agent_id', v_customer, 'reference_id', v_ref));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'valuation', v_valuation,
    'recovery_amount', v_recover,
    'daily_recovery', v_projection,
    'monthly_rate_pct', 28,
    'lease_term_months', v_term,
    'credited_agent_id', v_customer,
    'disbursement_group_id', v_group
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.coo_approve_bike_lease(p_sale_id uuid, p_valuation numeric DEFAULT NULL::numeric, p_lease_term_months integer DEFAULT NULL::integer, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_valuation numeric;
  v_term integer;
  v_projection numeric;
BEGIN
  IF NOT public.can_coo_approve_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to approve Spiro bike lease applications';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') IN ('submitted','pending_approval') THEN
    RAISE EXCEPTION 'Agent Ops must verify this application before the COO can approve it';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'ops_approved' THEN
    RAISE EXCEPTION 'Application is already %', COALESCE(v_sale.order_status, 'submitted');
  END IF;
  IF v_sale.customer_id IS NULL THEN
    RAISE EXCEPTION 'Application has no linked agent account';
  END IF;

  v_valuation := COALESCE(NULLIF(p_valuation, 0), v_sale.valuation_amount, v_sale.total_amount, v_sale.total_revenue, 0);
  IF v_valuation <= 0 THEN
    RAISE EXCEPTION 'Approved bike valuation must be greater than zero';
  END IF;
  v_term := GREATEST(COALESCE(NULLIF(p_lease_term_months, 0), v_sale.lease_term_months, 12), 1);
  v_projection := round((ceil(v_valuation / v_term) + round(v_valuation * 0.28)) / 30.0);

  UPDATE public.merchandise_sales
  SET order_status = 'coo_approved',
      valuation_amount = v_valuation,
      total_amount = v_valuation,
      total_revenue = v_valuation,
      unit_price = v_valuation / GREATEST(COALESCE(quantity, 1), 1),
      lease_term_months = v_term,
      lease_daily_rate = NULL,
      payment_projection = v_projection,
      payment_status = 'credit',
      coo_approved_by = v_uid,
      coo_approved_at = now(),
      notes = COALESCE(notes, '') || ' | COO approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' at valuation ' || to_char(v_valuation, 'FM999,999,999')
              || ' over ' || v_term || ' months - forwarded to CFO for disbursement'
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_coo_approved', 'merchandise_sales', p_sale_id,
            'COO approved the Spiro bike lease valuation and forwarded it to the CFO for disbursement',
            jsonb_build_object('valuation', v_valuation, 'lease_term_months', v_term,
                               'daily_recovery', v_projection, 'monthly_rate_pct', 28));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'coo_approved',
    'valuation', v_valuation,
    'lease_term_months', v_term,
    'daily_recovery', v_projection
  );
END;
$function$
;

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

    -- Bike leases: daily cap = current month's schedule instalment / 30 (28% reducing balance).
    v_lease_id := NULL; v_activated := NULL; v_bike_cap := NULL;
    IF v_plan.sale_id IS NOT NULL THEN
      SELECT id, lease_activated_at INTO v_lease_id, v_activated
      FROM public.agent_bike_leases WHERE sale_id = v_plan.sale_id;
    END IF;

    IF v_lease_id IS NOT NULL THEN
      IF v_activated IS NULL THEN CONTINUE; END IF;
      v_act_date := (v_activated AT TIME ZONE 'Africa/Kampala')::date;
      IF v_act_date > v_today THEN CONTINUE; END IF;
      v_month := (extract(year FROM age(v_today, v_act_date)) * 12
                  + extract(month FROM age(v_today, v_act_date)))::int + 1;
      SELECT max(version) INTO v_ver FROM public.agent_bike_lease_schedules WHERE lease_id = v_lease_id;
      IF v_ver IS NULL THEN CONTINUE; END IF;
      SELECT max(installment_no) INTO v_max_no FROM public.agent_bike_lease_schedules
      WHERE lease_id = v_lease_id AND version = v_ver;
      SELECT installment_amount INTO v_inst FROM public.agent_bike_lease_schedules
      WHERE lease_id = v_lease_id AND version = v_ver AND installment_no = LEAST(v_month, v_max_no);
      IF COALESCE(v_inst, 0) <= 0 THEN CONTINUE; END IF;
      v_bike_cap := GREATEST(round(v_inst / 30.0), 1);
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
$function$
;

COMMIT;
