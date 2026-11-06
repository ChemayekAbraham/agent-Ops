-- Tenants applying for themselves are not judged on their referring agent's collections.
--
-- The posting rule (20261023130000) is for AGENTS posting Rent Plans. Tenant-initiated requests
-- still carry the referring agent in agent_id (attribution and commission), so the gate on
-- rent_requests was refusing a tenant's own application whenever their referring agent was blocked
-- (e.g. 23 Oct: a tenant refused on his referrer's 29.7%; 1,943 tenants sat behind 85 blocked agents).
-- Decided with Pius 2026-10-23: tenant onboarding is not affected.
--
-- A request is a tenant self-application, and skips the gate, when either:
--   (a) the signed-in caller IS the tenant and is not the agent on the row
--       (RentRequestButton / RentRequestForm insert from the tenant's browser), or
--   (b) tenant_self_applied = true AND the insert has no signed-in caller (service key), which only
--       the tenant-self-onboarding edge function sets.
-- An agent's browser cannot use (b): it always has a signed-in caller, and the flag is cleared on
-- any insert that doesn't qualify, so it can't be used to slip past the gate.
-- Agent paths stay gated: AgentRentRequestDialog, register-tenant (service key, flag never set),
-- renew_rent_request, submit-tenant-form (an agent's shared link).

ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS tenant_self_applied boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.rent_requests.tenant_self_applied IS
  'True when the tenant applied for themselves (tenant-self-onboarding). Exempts the insert from the agent posting rule; only honoured on service-key inserts.';

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
  v_weekly       boolean;
  v_week_row     public.agent_weekly_posting_eligibility;
  v_caller       uuid := auth.uid();
BEGIN
  v_bypass := current_setting('app.bypass_daily_eligibility', true);
  IF v_bypass = 'true' THEN RETURN NEW; END IF;
  IF NEW.agent_id IS NULL THEN RETURN NEW; END IF;

  -- Tenant self-applications (20261023150000): the rule is for agents, not tenants.
  IF v_caller IS NOT NULL AND v_caller = NEW.tenant_id AND v_caller IS DISTINCT FROM NEW.agent_id THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_self_applied THEN
    IF v_caller IS NULL THEN
      RETURN NEW;
    END IF;
    -- Set by a signed-in caller who isn't the tenant: not honoured, and not kept.
    NEW.tenant_self_applied := false;
  END IF;

  SELECT s.enforce_weekly INTO v_weekly FROM public.agent_posting_rule_settings s WHERE s.id;

  IF COALESCE(v_weekly, false) THEN
    -- Weekly rule (20261023130000). No exemptions, no unlock.
    v_week_row := public._agent_weekly_posting_result(NEW.agent_id);
    IF v_week_row.agent_id IS NOT NULL AND NOT v_week_row.passes THEN
      RAISE EXCEPTION 'WEEKLY_ELIGIBILITY_BLOCKED: %', v_week_row.reason
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- ---- Old daily rule (unchanged; dead once enforce_weekly is true) ----
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
