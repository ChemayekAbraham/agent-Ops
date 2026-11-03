-- Rollback for 20261023130000_agent_weekly_posting_rule.sql
-- Puts enforce_agent_daily_eligibility() back to the daily-only rule, removes the weekly jobs,
-- functions and tables. Saved weekly results are lost (they can be recomputed from the bill
-- and agent_collections by re-applying the migration).
CREATE OR REPLACE FUNCTION public.enforce_agent_daily_eligibility()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_active_count int;
  v_tenants_due  int;
  v_cov_today    numeric;
  v_cov_yest     numeric;
  v_best_cov     numeric;
  v_today        date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_bypass       text;
BEGIN
  v_bypass := current_setting('app.bypass_daily_eligibility', true);
  IF v_bypass = 'true' THEN RETURN NEW; END IF;
  IF NEW.agent_id IS NULL THEN RETURN NEW; END IF;

  SELECT active_count, tenants_due, coverage_today, coverage_yesterday
    INTO v_active_count, v_tenants_due, v_cov_today, v_cov_yest
  FROM public.v_agent_daily_eligibility
  WHERE agent_id = NEW.agent_id;

  -- No measurable book at all.
  IF v_active_count IS NULL OR v_active_count = 0 THEN
    RETURN NEW;
  END IF;

  -- Guard 1: nothing was billed to this agent today or yesterday, so there is
  -- no denominator. Never let an absent measurement read as a failed one.
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_expected_day_plans e
    WHERE e.agent_id = NEW.agent_id
      AND e.day >= v_today - 1
  ) THEN
    RETURN NEW;
  END IF;

  -- Guard 1b: an explicit, recorded one-day grant by staff.
  IF EXISTS (
    SELECT 1 FROM public.agent_posting_gate_exemptions x
    WHERE x.agent_id = NEW.agent_id
      AND x.day = v_today
  ) THEN
    RETURN NEW;
  END IF;

  -- Guard 2: the weekly good-standing unlock the app already promises.
  IF EXISTS (
    SELECT 1
    FROM public.agent_daily_eligibility_history h
    WHERE h.agent_id = NEW.agent_id
      AND h.day >= v_today - 7
      AND h.rating IN ('Good', 'Very Good')
    GROUP BY h.agent_id
    HAVING count(DISTINCT h.day) >= 2
  ) THEN
    RETURN NEW;
  END IF;

  v_best_cov := GREATEST(COALESCE(v_cov_today, 0), COALESCE(v_cov_yest, 0));

  IF v_best_cov < 0.50 THEN
    RAISE EXCEPTION
      'DAILY_ELIGIBILITY_BLOCKED: agent reached % of the tenants who owed (target 50 percent). Collect from more of your existing tenants before posting new Rent Plans.',
      to_char(v_best_cov * 100, 'FM990.0') || '%'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$function$;

DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('snapshot-agent-weekly-posting-eligibility', 'snapshot-agent-weekly-posting-eligibility-am');
END
$cron$;

DROP FUNCTION IF EXISTS public.get_agent_weekly_posting_eligibility(uuid[]);
DROP FUNCTION IF EXISTS public._agent_weekly_posting_result(uuid);
DROP FUNCTION IF EXISTS public.snapshot_agent_weekly_posting_eligibility(date);
DROP FUNCTION IF EXISTS public._agent_weekly_posting_compute(date, uuid[]);
DROP FUNCTION IF EXISTS public._agent_rule_judged_week_start();
DROP FUNCTION IF EXISTS public._agent_rule_week_start(date);
DROP TABLE IF EXISTS public.agent_weekly_posting_eligibility;
DROP TABLE IF EXISTS public.agent_posting_rule_settings;
