CREATE OR REPLACE FUNCTION public.enforce_minimum_withdrawal_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_managed_agent UUID;
  available_self NUMERIC := 0;
  available_proxy NUMERIC := 0;
  available NUMERIC := 0;
BEGIN
  IF NEW.status = 'pending' THEN
    -- Always evaluate the requesting user's OWN available balance first.
    -- An agent withdrawing their own wallet must never be blocked just
    -- because they are ALSO listed as a managed-proxy beneficiary.
    BEGIN
      available_self := COALESCE(public.get_user_available_balance(NEW.user_id), 0);
    EXCEPTION WHEN OTHERS THEN
      SELECT COALESCE(withdrawable_balance, 0) INTO available_self
      FROM public.wallets WHERE user_id = NEW.user_id;
      available_self := COALESCE(available_self, 0);
    END;

    -- If the request is on behalf of a partner who has an active, approved
    -- managed-proxy assignment, the funds may actually live in the proxy
    -- agent's wallet (managed-proxy payout routing). Evaluate that too.
    SELECT paa.agent_id INTO v_managed_agent
    FROM public.proxy_agent_assignments paa
    WHERE paa.beneficiary_id = NEW.user_id
      AND paa.is_active = true
      AND paa.approval_status = 'approved'
      AND paa.is_managed_account = true
    ORDER BY paa.created_at DESC
    LIMIT 1;

    IF v_managed_agent IS NOT NULL THEN
      BEGIN
        available_proxy := COALESCE(public.get_user_available_balance(v_managed_agent), 0);
      EXCEPTION WHEN OTHERS THEN
        SELECT COALESCE(withdrawable_balance, 0) INTO available_proxy
        FROM public.wallets WHERE user_id = v_managed_agent;
        available_proxy := COALESCE(available_proxy, 0);
      END;
    END IF;

    -- Allow the withdrawal if EITHER source can cover it.
    available := GREATEST(available_self, available_proxy);

    IF available < 5000 THEN
      RAISE EXCEPTION
        'Withdrawal blocked: Your withdrawable balance must be at least UGX 5,000 to submit a withdrawal request. Available: %',
        available;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;