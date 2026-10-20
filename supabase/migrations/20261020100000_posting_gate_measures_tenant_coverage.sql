-- The posting gate now measures what the rating measures: tenant coverage.
--
-- On 2026-08-31 the agent rating was deliberately moved off amounts and onto
-- coverage — "how many of their due tenants they got to pay today, and NOT the
-- UGX percentage of the expected daily book", so that tenants choosing to pay
-- less than their daily amount no longer dragged an agent down. The posting
-- gate was never moved with it, so for two months the gate judged agents on
-- exactly the thing the rating was changed to stop judging them on. It did not
-- show while targets were low enough that the money ratio usually cleared 50%.
--
-- Billing the arrears book (20261019104000) ended that truce. It raised the
-- denominator for the money measures but not for coverage, which counts tenants
-- and is indifferent to amounts. The result on 2026-10-20:
--
--   NSUBUGA Lawrence George   17/17 tenants paid   coverage 100%   amount 19.2%   BLOCKED
--   NATTU SHARIFAH            11/11 tenants paid   coverage 100%   amount 15.4%   BLOCKED
--
-- Both reached every single tenant on their book, were badged "Very Good" by
-- the app, and were refused by the database. Both measures were correct on
-- their own definition; only one of them should be deciding.
--
-- Gate is now GREATEST(coverage_today, coverage_yesterday) >= 0.50 — did you
-- reach at least half the tenants who owed you, on your better of the two days.
-- Fleet effect is small (84 blocked against 85 before); the point is that the
-- agents it blocks are the ones who did not do the work.
--
-- Two guards worth keeping in view:
--
--   1. A zero denominator must never read as failure. coverage_today falls back
--      to 0 when an agent has no due tenants but carries stale debt, which would
--      block them permanently with no way to earn their way out — the same shape
--      that made `expected_daily = 0` a lockout. So an agent with nothing pinned
--      on either day is passed through: there is nothing to measure. No agent is
--      in that state today; the guard is here so it cannot become one silently.
--
--   2. The app grants unlimited posting after 2 "Good" days in the last 7
--      (GOOD_DAYS_UNLOCK_THRESHOLD in useAgentCapacityMap). The trigger had never
--      heard of it, so the app told agents they could post and the insert failed.
--      The unlock is honoured here rather than removed from the app, because it
--      is a promise already made to agents who earned it. To retire it, delete
--      both sides together.
CREATE OR REPLACE FUNCTION public.enforce_agent_daily_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
$fn$;
