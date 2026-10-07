CREATE OR REPLACE FUNCTION public._spiro_month_days(p_start date, p_month integer)
 RETURNS integer LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$ SELECT 30 $function$;

CREATE OR REPLACE FUNCTION public._merch_bike_day(p_sale_id uuid, p_v2 boolean, p_day date)
 RETURNS TABLE(daily numeric, fee_ratio numeric, term_end date, active boolean)
 LANGUAGE plpgsql STABLE SET search_path TO 'public'
AS $function$
DECLARE l record; a date; m int; inst numeric; fee numeric; ver int; mx int; v_starts date;
BEGIN
  SELECT id, lease_activated_at, valuation_amount, GREATEST(COALESCE(lease_term_months,12),1) AS term
    INTO l FROM public.agent_bike_leases WHERE sale_id = p_sale_id;
  IF l.id IS NULL OR l.lease_activated_at IS NULL THEN active := false; RETURN NEXT; RETURN; END IF;
  SELECT starts_on INTO v_starts FROM public.merchandise_recovery_plans
   WHERE sale_id = p_sale_id AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1;
  a := COALESCE(v_starts, (l.lease_activated_at AT TIME ZONE 'Africa/Kampala')::date + 2);
  -- Flat 30-day lease months.
  term_end := a + 30 * l.term;
  IF p_day < a THEN active := false; RETURN NEXT; RETURN; END IF;
  active := true;
  m := LEAST(((p_day - a) / 30) + 1, l.term);
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
  daily := GREATEST(round(COALESCE(inst,0) / 30), 0);
  RETURN NEXT;
END $function$;