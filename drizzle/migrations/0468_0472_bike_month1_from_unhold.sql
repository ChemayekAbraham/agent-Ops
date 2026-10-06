CREATE OR REPLACE FUNCTION public._merch_bike_day(p_sale_id uuid, p_v2 boolean, p_day date)
 RETURNS TABLE(daily numeric, fee_ratio numeric, term_end date, active boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE l record; a date; m int; inst numeric; fee numeric; ver int; mx int; v_starts date;
BEGIN
  SELECT id, lease_activated_at, valuation_amount, GREATEST(COALESCE(lease_term_months,12),1) AS term
    INTO l FROM public.agent_bike_leases WHERE sale_id = p_sale_id;
  IF l.id IS NULL OR l.lease_activated_at IS NULL THEN active := false; RETURN NEXT; RETURN; END IF;
  SELECT starts_on INTO v_starts FROM public.merchandise_recovery_plans
   WHERE sale_id = p_sale_id AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1;
  -- Month 1 = the plan's start day if set (e.g. the day it came off hold), else release day + 2 (Kampala).
  a := COALESCE(v_starts, (l.lease_activated_at AT TIME ZONE 'Africa/Kampala')::date + 2);
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

CREATE OR REPLACE FUNCTION public.trg_bike_plan_unhold_starts_month1()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $f$
BEGIN
  IF COALESCE(NEW.is_bike_lease,false) AND COALESCE(OLD.recovery_hold,false) AND NOT COALESCE(NEW.recovery_hold,false) THEN
    -- Month 1 starts the day the plan comes off hold; nothing before that counts as arrears.
    NEW.starts_on := (now() AT TIME ZONE 'Africa/Kampala')::date;
    NEW.recovery_started_on := NULL; NEW.due_accrued_through := NULL; NEW.due_balance := 0; NEW.term_end_on := NULL;
    NEW.last_success_on := NULL; NEW.last_attempt_on := NULL; NEW.last_attempt_result := NULL;
    NEW.daily_amount_fixed := NULL; NEW.miss_alert_sent := false;
  END IF;
  RETURN NEW;
END $f$;

DROP TRIGGER IF EXISTS trg_bike_plan_unhold_starts_month1 ON public.merchandise_recovery_plans;
CREATE TRIGGER trg_bike_plan_unhold_starts_month1 BEFORE UPDATE OF recovery_hold ON public.merchandise_recovery_plans
  FOR EACH ROW EXECUTE FUNCTION public.trg_bike_plan_unhold_starts_month1();