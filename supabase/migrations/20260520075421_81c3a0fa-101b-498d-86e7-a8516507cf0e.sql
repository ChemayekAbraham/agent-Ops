CREATE OR REPLACE FUNCTION public.enforce_withdrawal_ledger_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available numeric;
  v_check_user_id uuid;
  v_proxy_partner_id uuid;
  v_managed_agent_id uuid;
BEGIN
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    INSERT INTO public.withdrawal_attempt_failures (
      user_id, attempted_amount, ledger_available, reason, client_request_id
    ) VALUES (
      NEW.user_id, COALESCE(NEW.amount, 0), 0,
      'INVALID_AMOUNT', NEW.client_request_id
    );
    RAISE EXCEPTION 'Invalid withdrawal amount'
      USING ERRCODE = '22023';
  END IF;

  v_proxy_partner_id := COALESCE(
    NEW.proxy_partner_id,
    NEW.beneficiary_id,
    CASE
      WHEN NEW.linked_party IS NOT NULL AND NEW.linked_party <> NEW.user_id THEN NEW.linked_party
      ELSE NULL
    END
  );

  IF v_proxy_partner_id IS NOT NULL THEN
    SELECT paa.agent_id
    INTO v_managed_agent_id
    FROM public.proxy_agent_assignments paa
    WHERE paa.beneficiary_id = v_proxy_partner_id
      AND paa.is_active = true
      AND paa.approval_status = 'approved'
      AND paa.is_managed_account = true
      AND (
        paa.agent_id = NEW.agent_id
        OR paa.agent_id = NEW.initiated_by
        OR (NEW.user_id <> v_proxy_partner_id AND paa.agent_id = NEW.user_id)
      )
    ORDER BY paa.created_at DESC
    LIMIT 1;
  END IF;

  v_check_user_id := COALESCE(v_managed_agent_id, NEW.user_id);

  SELECT public.get_user_available_balance(v_check_user_id) INTO v_available;
  v_available := COALESCE(v_available, 0);

  IF NEW.amount > v_available THEN
    INSERT INTO public.withdrawal_attempt_failures (
      user_id, attempted_amount, ledger_available, reason, client_request_id,
      metadata
    ) VALUES (
      NEW.user_id, NEW.amount, v_available,
      'LEDGER_MISMATCH', NEW.client_request_id,
      jsonb_build_object(
        'mobile_money_provider', NEW.mobile_money_provider,
        'mobile_money_number', NEW.mobile_money_number,
        'checked_user_id', v_check_user_id,
        'proxy_partner_id', v_proxy_partner_id,
        'managed_proxy_agent_id', v_managed_agent_id,
        'funding_wallet', CASE WHEN v_managed_agent_id IS NOT NULL THEN 'proxy_agent' ELSE 'request_owner' END
      )
    );
    RAISE EXCEPTION
      'Ledger mismatch detected. Available: %, requested: %. Transaction aborted.',
      v_available, NEW.amount
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;