CREATE OR REPLACE FUNCTION public.enforce_minimum_withdrawal_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_check_user_id UUID;
  v_managed_agent UUID;
  available NUMERIC;
BEGIN
  IF NEW.status = 'pending' THEN
    -- If the request is on behalf of a partner who has an active,
    -- approved managed-proxy assignment, the funds actually live in
    -- the proxy agent's wallet (see managed-proxy payout routing).
    -- We must therefore evaluate the AGENT's available balance —
    -- otherwise the partner's empty wallet falsely blocks the request.
    SELECT paa.agent_id INTO v_managed_agent
    FROM public.proxy_agent_assignments paa
    WHERE paa.beneficiary_id = NEW.user_id
      AND paa.is_active = true
      AND paa.approval_status = 'approved'
      AND paa.is_managed_account = true
    ORDER BY paa.created_at DESC
    LIMIT 1;

    v_check_user_id := COALESCE(v_managed_agent, NEW.user_id);

    BEGIN
      available := COALESCE(public.get_user_available_balance(v_check_user_id), 0);
    EXCEPTION WHEN OTHERS THEN
      SELECT COALESCE(withdrawable_balance, 0) INTO available
      FROM public.wallets
      WHERE user_id = v_check_user_id;
      available := COALESCE(available, 0);
    END;

    IF available < 5000 THEN
      RAISE EXCEPTION
        'Withdrawal blocked: Your withdrawable balance must be at least UGX 5,000 to submit a withdrawal request. Available: %',
        available;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;