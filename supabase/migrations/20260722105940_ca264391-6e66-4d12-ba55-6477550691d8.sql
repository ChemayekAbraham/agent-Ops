
-- 1) Config flag with 1-hour expiry
INSERT INTO public.system_config(key, value, updated_at)
VALUES ('agent_perf_gate_disabled_until', to_jsonb((now() + interval '1 hour')::text), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- 2) Public-callable helper (RLS on system_config blocks direct SELECT)
CREATE OR REPLACE FUNCTION public.is_agent_perf_gate_disabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT (value #>> '{}')::timestamptz > now()
       FROM public.system_config
      WHERE key = 'agent_perf_gate_disabled_until'),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_agent_perf_gate_disabled() TO authenticated, anon;

-- 3) Patch enforcement trigger to honor the flag
CREATE OR REPLACE FUNCTION public.enforce_agent_perf_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_agent boolean;
  v_is_merchant boolean;
  v_is_proxy boolean;
  v_perf record;
  v_pct numeric;
  v_disabled_until timestamptz;
BEGIN
  -- Global temporary bypass (managed via system_config.agent_perf_gate_disabled_until).
  SELECT (value #>> '{}')::timestamptz INTO v_disabled_until
    FROM public.system_config
   WHERE key = 'agent_perf_gate_disabled_until';
  IF v_disabled_until IS NOT NULL AND v_disabled_until > now() THEN
    RETURN NEW;
  END IF;

  IF NEW.landlord_payout_id IS NOT NULL
     OR NEW.proxy_partner_id IS NOT NULL
     OR NEW.assigned_cashout_agent_id IS NOT NULL
     OR NEW.beneficiary_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.cashout_agents
    WHERE agent_id = NEW.user_id AND is_active = true
  ) INTO v_is_merchant;
  IF v_is_merchant THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.proxy_agent_assignments
    WHERE agent_id = NEW.user_id AND is_active = true
  ) INTO v_is_proxy;
  IF v_is_proxy THEN
    RETURN NEW;
  END IF;

  SELECT public.has_role(NEW.user_id, 'agent'::app_role)
      OR public.has_role(NEW.user_id, 'senior_agent'::app_role)
    INTO v_is_agent;
  IF NOT v_is_agent THEN
    RETURN NEW;
  END IF;

  SELECT active_count, expected_daily, paid_today, today_pct
    INTO v_perf
    FROM public.v_agent_daily_eligibility
   WHERE agent_id = NEW.user_id;

  IF v_perf IS NULL OR COALESCE(v_perf.expected_daily,0) <= 0 OR COALESCE(v_perf.active_count,0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_pct := COALESCE(v_perf.today_pct,0) * 100;
  IF v_pct < 20 THEN
    RAISE EXCEPTION 'Withdrawals disabled: collection performance today is %.1f%% (min 20%%).', v_pct
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;
