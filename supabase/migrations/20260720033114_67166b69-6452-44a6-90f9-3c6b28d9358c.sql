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
BEGIN
  -- Landlord-float / proxy-partner / cashout-agent / beneficiary routed
  -- withdrawals are not gated by the collection-performance rule.
  IF NEW.landlord_payout_id IS NOT NULL
     OR NEW.proxy_partner_id IS NOT NULL
     OR NEW.assigned_cashout_agent_id IS NOT NULL
     OR NEW.beneficiary_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Merchant Agents (active cashout_agents row) are payout operators only —
  -- they have no active tenants and are exempt from the 20% collection gate.
  SELECT EXISTS (
    SELECT 1 FROM public.cashout_agents
    WHERE agent_id = NEW.user_id AND is_active = true
  ) INTO v_is_merchant;
  IF v_is_merchant THEN
    RETURN NEW;
  END IF;

  -- Proxy Agents (active proxy_agent_assignments) withdraw on behalf of
  -- funders/supporters and are similarly exempt.
  SELECT EXISTS (
    SELECT 1 FROM public.proxy_agent_assignments
    WHERE agent_id = NEW.user_id AND is_active = true
  ) INTO v_is_proxy;
  IF v_is_proxy THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = NEW.user_id
      AND role::text = 'agent'
  ) INTO v_is_agent;

  IF NOT v_is_agent THEN
    RETURN NEW;
  END IF;

  SELECT active_count, expected_daily, paid_today, today_pct
  INTO v_perf
  FROM public.v_agent_daily_eligibility
  WHERE agent_id = NEW.user_id;

  IF v_perf IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_perf.expected_daily, 0) <= 0 OR COALESCE(v_perf.active_count, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_pct := COALESCE(v_perf.today_pct, 0) * 100;

  IF v_pct < 20 THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'Withdrawals disabled: your collection performance today is %s%% (%s / %s across %s active tenants). Welile requires at least 20%% before you can withdraw from your wallet. Collect from more tenants today, then try again. Landlord-float payouts are not affected by this rule.',
        round(v_pct, 1),
        v_perf.paid_today,
        v_perf.expected_daily,
        v_perf.active_count
      ),
      ERRCODE = 'P0001',
      HINT = 'agent_perf_below_threshold';
  END IF;

  RETURN NEW;
END;
$function$;