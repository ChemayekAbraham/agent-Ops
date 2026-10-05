-- Rollback 0472: restore Mata Pius / ALPHA SSEMA rows as of 2026-10-05T14:04:45Z and the previous _merch_bike_day.
UPDATE public.merchandise_sales SET valuation_amount='710000',total_amount='710000',total_revenue='710000',unit_price='710000.000000000000',amount_outstanding='710000',payment_projection='106500' WHERE id='a3228b88-6f28-459b-9ef4-48bfd11d3e44';
UPDATE public.merchandise_sales SET valuation_amount='710000',total_amount='710000',total_revenue='710000',unit_price='710000.000000000000',amount_outstanding='710000',payment_projection='106500' WHERE id='a544f375-e454-4ed6-a794-81a500916c8a';
UPDATE public.agent_bike_leases SET valuation_amount='710000',amount_outstanding='710000' WHERE sale_id='a3228b88-6f28-459b-9ef4-48bfd11d3e44';
UPDATE public.agent_bike_leases SET valuation_amount='710000',amount_outstanding='710000' WHERE sale_id='a544f375-e454-4ed6-a794-81a500916c8a';
UPDATE public.merchandise_recovery_plans p SET (original_amount,outstanding_balance,principal_total,fee_total,amount_recovered,fee_recovered,principal_recovered,pricing_basis,status,starts_on,recovery_started_on,due_accrued_through,due_balance,term_end_on,last_success_on,last_attempt_on,last_attempt_result,daily_amount_fixed,miss_alert_sent,recovery_hold,recovery_hold_reason) = (SELECT original_amount,outstanding_balance,principal_total,fee_total,amount_recovered,fee_recovered,principal_recovered,pricing_basis,status,starts_on,recovery_started_on,due_accrued_through,due_balance,term_end_on,last_success_on,last_attempt_on,last_attempt_result,daily_amount_fixed,miss_alert_sent,recovery_hold,recovery_hold_reason FROM jsonb_populate_record(NULL::public.merchandise_recovery_plans, '{"id": "bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9", "status": "active", "sale_id": "a3228b88-6f28-459b-9ef4-48bfd11d3e44", "fee_total": null, "item_name": "Welile Spiro Bike", "starts_on": null, "created_at": "2026-09-09T13:41:42.070043+00:00", "created_by": "6aac6c81-b0f8-45eb-a67b-6483e7dcf82f", "daily_rate": 0, "updated_at": "2026-10-05T13:26:48.242798+00:00", "customer_id": "6aac6c81-b0f8-45eb-a67b-6483e7dcf82f", "due_balance": 0, "term_end_on": null, "completed_at": null, "customer_name": "Mata Pius", "fee_recovered": 0, "is_bike_lease": true, "pricing_basis": null, "recovery_hold": true, "customer_phone": "+256776368807", "last_attempt_on": null, "last_success_on": null, "miss_alert_sent": false, "original_amount": 710000, "principal_total": null, "amount_recovered": 0, "last_recovery_at": null, "last_surcharge_on": null, "daily_amount_fixed": null, "due_accrued_through": null, "last_attempt_result": null, "outstanding_balance": 710000, "principal_recovered": 0, "recovery_started_on": null, "recovery_hold_reason": "Held 2026-10-05: plan 710,000 vs 28% schedule 2,002,193 — terms awaiting decision", "last_bike_recovery_on": null, "daily_deduction_amount": 1000, "overdue_surcharge_total": 0}'::jsonb)) WHERE id='bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9';
UPDATE public.merchandise_recovery_plans p SET (original_amount,outstanding_balance,principal_total,fee_total,amount_recovered,fee_recovered,principal_recovered,pricing_basis,status,starts_on,recovery_started_on,due_accrued_through,due_balance,term_end_on,last_success_on,last_attempt_on,last_attempt_result,daily_amount_fixed,miss_alert_sent,recovery_hold,recovery_hold_reason) = (SELECT original_amount,outstanding_balance,principal_total,fee_total,amount_recovered,fee_recovered,principal_recovered,pricing_basis,status,starts_on,recovery_started_on,due_accrued_through,due_balance,term_end_on,last_success_on,last_attempt_on,last_attempt_result,daily_amount_fixed,miss_alert_sent,recovery_hold,recovery_hold_reason FROM jsonb_populate_record(NULL::public.merchandise_recovery_plans, '{"id": "93d95269-34da-45f0-9845-fff6b7312220", "status": "active", "sale_id": "a544f375-e454-4ed6-a794-81a500916c8a", "fee_total": null, "item_name": "Welile Spiro Bike", "starts_on": null, "created_at": "2026-09-09T13:54:33.843734+00:00", "created_by": "9188db01-e54a-4f84-8de9-042e6b5b6bd6", "daily_rate": 0, "updated_at": "2026-10-05T13:26:48.242798+00:00", "customer_id": "9188db01-e54a-4f84-8de9-042e6b5b6bd6", "due_balance": 0, "term_end_on": null, "completed_at": null, "customer_name": "ALPHA SSEMA", "fee_recovered": 0, "is_bike_lease": true, "pricing_basis": null, "recovery_hold": true, "customer_phone": "+256752760263", "last_attempt_on": null, "last_success_on": null, "miss_alert_sent": false, "original_amount": 710000, "principal_total": null, "amount_recovered": 0, "last_recovery_at": null, "last_surcharge_on": null, "daily_amount_fixed": null, "due_accrued_through": null, "last_attempt_result": null, "outstanding_balance": 710000, "principal_recovered": 0, "recovery_started_on": null, "recovery_hold_reason": "Held 2026-10-05: plan 710,000 vs 28% schedule 2,002,193 — terms awaiting decision", "last_bike_recovery_on": null, "daily_deduction_amount": 0, "overdue_surcharge_total": 0}'::jsonb)) WHERE id='93d95269-34da-45f0-9845-fff6b7312220';

DROP TRIGGER IF EXISTS trg_bike_plan_unhold_starts_month1 ON public.merchandise_recovery_plans; DROP FUNCTION IF EXISTS public.trg_bike_plan_unhold_starts_month1();
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
END $function$

;
