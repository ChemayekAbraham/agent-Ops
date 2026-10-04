CREATE OR REPLACE FUNCTION public.enforce_agent_daily_eligibility()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_active_count   int;
  v_effective_pct  numeric;
  v_raw_today      numeric;
  v_raw_yesterday  numeric;
  v_best_pct       numeric;
  v_bypass         text;
BEGIN
  v_bypass := current_setting('app.bypass_daily_eligibility', true);
  IF v_bypass = 'true' THEN RETURN NEW; END IF;
  IF NEW.agent_id IS NULL THEN RETURN NEW; END IF;

  SELECT active_count, effective_pct, raw_today_pct, raw_yesterday_pct
    INTO v_active_count, v_effective_pct, v_raw_today, v_raw_yesterday
  FROM public.v_agent_daily_eligibility
  WHERE agent_id = NEW.agent_id;

  IF v_active_count IS NULL OR v_active_count = 0 THEN
    RETURN NEW;
  END IF;

  v_best_pct := GREATEST(
    COALESCE(v_effective_pct, 0),
    COALESCE(v_raw_today, 0),
    COALESCE(v_raw_yesterday, 0)
  );

  IF v_best_pct < 0.50 THEN
    RAISE EXCEPTION
      'DAILY_ELIGIBILITY_BLOCKED: agent collected % of expected daily (target 50 percent). Collect from existing tenants before posting new rent requests.',
      to_char(v_best_pct * 100, 'FM990.0') || '%'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;