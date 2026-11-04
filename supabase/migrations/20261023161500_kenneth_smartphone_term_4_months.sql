-- Data fix: shorten KENNETH SEKABEMBE's Welile Smartphone Rent Plan from 12 to 4 months.
-- Requested by Agent Ops (Kalyango Timothy) on 2026-10-23.
--
-- Sale 561e4919-4a93-4961-a33f-5900d0f11276, plan 1cab4fe8-136d-493b-b74c-d9ac28e4e77c.
-- Phone price UGX 800,000; repayments started 2026-10-22 (unchanged).
-- Rebuilt with the same functions and field updates as cfo_disburse_smartphone_order:
--   12 months: total UGX 2,256,014, 365 days, first daily UGX 9,377
--    4 months: total UGX 1,360,000, 123 days, first daily UGX 13,678
-- What is still owed = new total minus what has actually been repaid when this runs
-- (UGX 2,000 on 2026-10-23, leaving UGX 1,358,000). Repayments already made are kept.
-- No ledger change: the advance was booked at the phone price, charges are not posted up front.
--
-- Guarded: runs only while the plan is still the original 12-month one, so re-running does nothing.

DO $$
DECLARE
  v_sale_id constant uuid := '561e4919-4a93-4961-a33f-5900d0f11276';
  v_plan_id constant uuid := '1cab4fe8-136d-493b-b74c-d9ac28e4e77c';
  v_months  constant int  := 4;
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
  IF v_sale.advance_period_months IS DISTINCT FROM 12 OR v_plan.status <> 'active' THEN
    RAISE NOTICE 'already changed or plan not active (months %, status %), skipping',
      v_sale.advance_period_months, v_plan.status;
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
         amount_outstanding = GREATEST(v_total - COALESCE(amount_paid, 0), 0),
         notes = COALESCE(notes, '') || ' | Term changed 12 -> 4 months by Agent Ops on 2026-10-23: total '
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
    'Agent Ops request: shorten Rent Plan from 12 to 4 months',
    jsonb_build_object('months', v_sale.advance_period_months, 'total_repayable', v_sale.total_repayable,
                       'amount_outstanding', v_sale.amount_outstanding,
                       'access_repayment_days', v_sale.access_repayment_days,
                       'plan_daily_deduction', v_plan.daily_deduction_amount),
    jsonb_build_object('months', v_months, 'total_repayable', v_total, 'access_repayment_days', v_days,
                       'amount_outstanding', GREATEST(v_total - COALESCE(v_sale.amount_paid, 0), 0),
                       'plan_daily_deduction', v_daily),
    jsonb_build_object('plan_id', v_plan_id, 'requested_by', 'kalyango.timothy@welile.com',
                       'repaid_before_change', COALESCE(v_plan.amount_recovered, 0)));
END $$;
