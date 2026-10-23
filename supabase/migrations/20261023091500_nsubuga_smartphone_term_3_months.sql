-- Data fix: shorten NSUBUGA Lawrence George's Welile Smartphone Rent Plan from 9 to 3 months.
-- Requested by Agent Ops (Kalyango Timothy) on 2026-10-23.
--
-- Sale c60db3db-334d-453e-89b8-aa1557535778, plan 973c6ecb-3c1a-4f3d-8471-106fc460aec7.
-- Phone price UGX 950,000; repayments start 2026-10-26 (unchanged); nothing repaid yet.
-- Rebuilt with the same functions and field updates as cfo_disburse_smartphone_order:
--   9 months: total UGX 2,280,006, 273 days, first daily UGX 11,986
--   3 months: total UGX 1,482,001,  92 days, first daily UGX 18,796
-- No ledger change: the advance was booked at the phone price, charges are not posted up front.
--
-- Guarded: runs only while the plan is still the original 9-month one with nothing repaid,
-- so re-running it (or running it after any repayment) does nothing.

DO $$
DECLARE
  v_sale_id constant uuid := 'c60db3db-334d-453e-89b8-aa1557535778';
  v_plan_id constant uuid := '973c6ecb-3c1a-4f3d-8471-106fc460aec7';
  v_months  constant int  := 3;
  v_sale  record;
  v_plan  record;
  v_sched jsonb;
  v_total numeric;
  v_daily numeric;
  v_days  int;
BEGIN
  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = v_sale_id FOR UPDATE;
  SELECT * INTO v_plan FROM public.merchandise_recovery_plans WHERE id = v_plan_id FOR UPDATE;

  IF v_sale.id IS NULL OR v_plan.id IS NULL THEN
    RAISE NOTICE 'sale or plan not found, skipping';
    RETURN;
  END IF;
  IF v_sale.advance_period_months IS DISTINCT FROM 9
     OR COALESCE(v_sale.amount_paid, 0) <> 0
     OR COALESCE(v_plan.amount_recovered, 0) <> 0 THEN
    RAISE NOTICE 'already changed or repayments started (months %, paid %, recovered %), skipping',
      v_sale.advance_period_months, v_sale.amount_paid, v_plan.amount_recovered;
    RETURN;
  END IF;

  v_sched := public.smartphone_rebuild_repayment_schedule(
    v_sale_id, v_sale.total_revenue, v_months, v_sale.repayment_starts_on);
  v_total := (v_sched->>'total_repayable')::numeric;
  v_daily := (v_sched->>'first_daily')::numeric;
  v_days  := (v_sched->>'days')::int;

  UPDATE public.merchandise_sales
     SET advance_period_months = v_months,
         advance_markup_pct = round((v_total - total_revenue) * 100 / total_revenue, 2),
         total_repayable = v_total,
         access_daily_amount = v_daily,
         access_repayment_days = v_days,
         payment_projection = v_total - total_revenue,
         amount_outstanding = v_total - COALESCE(amount_paid, 0),
         notes = COALESCE(notes, '') || ' | Term changed 9 -> 3 months by Agent Ops on 2026-10-23: total '
                 || to_char(v_total, 'FM999,999,999') || ', first daily ' || to_char(v_daily, 'FM999,999,999'),
         updated_at = now()
   WHERE id = v_sale_id;

  UPDATE public.merchandise_recovery_plans
     SET original_amount = v_total,
         outstanding_balance = GREATEST(v_total - COALESCE(amount_recovered, 0), 0),
         daily_deduction_amount = v_daily,
         updated_at = now()
   WHERE id = v_plan_id;

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, old_values, new_values, metadata)
  VALUES (NULL, 'smartphone_term_change', 'update', 'merchandise_sales', v_sale_id::text,
    'Agent Ops request: shorten Rent Plan from 9 to 3 months',
    jsonb_build_object('months', v_sale.advance_period_months, 'total_repayable', v_sale.total_repayable,
                       'access_repayment_days', v_sale.access_repayment_days,
                       'plan_daily_deduction', v_plan.daily_deduction_amount),
    jsonb_build_object('months', v_months, 'total_repayable', v_total, 'access_repayment_days', v_days,
                       'plan_daily_deduction', v_daily),
    jsonb_build_object('plan_id', v_plan_id, 'requested_by', 'kalyango.timothy@welile.com'));
END $$;
