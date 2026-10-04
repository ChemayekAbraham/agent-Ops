
CREATE OR REPLACE FUNCTION public.enforce_agent_perf_withdrawal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_agent boolean;
  v_perf record;
  v_pct numeric;
BEGIN
  -- Skip landlord-float payouts, proxy-partner routing, and any request tied
  -- to an assigned cashout agent (that's third-party money passing through).
  IF NEW.landlord_payout_id IS NOT NULL
     OR NEW.proxy_partner_id IS NOT NULL
     OR NEW.assigned_cashout_agent_id IS NOT NULL
     OR NEW.beneficiary_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = NEW.user_id
      AND role IN ('agent','merchant_agent','proxy_agent','senior_agent')
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

  IF v_perf.expected_daily <= 0 OR v_perf.active_count <= 0 THEN
    RETURN NEW; -- no active tenants today, nothing to enforce against
  END IF;

  v_pct := COALESCE(v_perf.today_pct, 0);
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
$$;

DROP TRIGGER IF EXISTS trg_enforce_agent_perf_withdrawal ON public.withdrawal_requests;
CREATE TRIGGER trg_enforce_agent_perf_withdrawal
  BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_agent_perf_withdrawal();
