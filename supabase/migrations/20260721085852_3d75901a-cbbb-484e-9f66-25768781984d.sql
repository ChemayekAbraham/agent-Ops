CREATE OR REPLACE FUNCTION public.enforce_withdrawal_ledger_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available numeric := 0;
  v_reason text := lower(coalesce(NEW.reason, ''));
  v_is_commission boolean := false;
  v_commission_earned numeric := 0;
  v_commission_withdrawn numeric := 0;
  v_pending_commission numeric := 0;
  v_check_user uuid;
  v_is_proxy boolean := false;
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

  -- Landlord-float payouts: the merchant queue row is fully backed by the
  -- agent_landlord_float row, which landlord-payout-disburse deducts atomically
  -- BEFORE inserting this withdrawal_request. It is NOT paid from the agent's
  -- withdrawable wallet, so the wallet ledger check does not apply.
  IF NEW.landlord_payout_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_is_commission := v_reason IN (
    'commission payout',
    'cash-out commission',
    'cashout commission',
    'cash-out commission payout',
    'cashout commission payout'
  );

  v_is_proxy := (
    NEW.proxy_partner_id IS NOT NULL
    AND NEW.agent_id IS NOT NULL
    AND NEW.agent_id <> NEW.user_id
  );
  v_check_user := CASE WHEN v_is_proxy THEN NEW.agent_id ELSE NEW.user_id END;

  IF v_is_commission THEN
    SELECT COALESCE(SUM(amount), 0)
      INTO v_commission_earned
    FROM public.general_ledger
    WHERE user_id = v_check_user
      AND ledger_scope = 'wallet'
      AND direction = 'cash_in'
      AND category = 'agent_commission_earned'
      AND reference_id LIKE '%-cashout-commission';

    SELECT COALESCE(SUM(amount), 0)
      INTO v_commission_withdrawn
    FROM public.general_ledger
    WHERE user_id = v_check_user
      AND ledger_scope = 'wallet'
      AND direction IN ('cash_out', 'debit')
      AND category IN ('agent_commission_withdrawal', 'agent_commission_used_for_rent');

    SELECT COALESCE(SUM(wr.amount), 0)
      INTO v_pending_commission
    FROM public.withdrawal_requests wr
    WHERE wr.user_id = v_check_user
      AND wr.status IN ('pending','requested','manager_approved','processing','approved')
      AND lower(coalesce(wr.reason, '')) IN (
        'commission payout',
        'cash-out commission',
        'cashout commission',
        'cash-out commission payout',
        'cashout commission payout'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.general_ledger gl
        WHERE gl.source_table = 'withdrawal_requests'
          AND gl.source_id = wr.id
          AND gl.ledger_scope = 'wallet'
          AND gl.direction IN ('cash_out','debit')
          AND gl.category IN ('agent_commission_withdrawal', 'agent_commission_used_for_rent')
      );

    v_available := GREATEST(0, v_commission_earned - v_commission_withdrawn - v_pending_commission);
  ELSE
    SELECT public.get_user_available_balance(v_check_user) INTO v_available;
    v_available := COALESCE(v_available, 0);
  END IF;

  IF NEW.amount > v_available THEN
    INSERT INTO public.withdrawal_attempt_failures (
      user_id, attempted_amount, ledger_available, reason, client_request_id,
      metadata
    ) VALUES (
      NEW.user_id, NEW.amount, v_available,
      CASE WHEN v_is_commission THEN 'COMMISSION_BALANCE_EXCEEDED' ELSE 'LEDGER_MISMATCH' END,
      NEW.client_request_id,
      jsonb_build_object(
        'mobile_money_provider', NEW.mobile_money_provider,
        'mobile_money_number', NEW.mobile_money_number,
        'withdrawal_reason', NEW.reason,
        'is_commission_withdrawal', v_is_commission,
        'is_proxy_withdrawal', v_is_proxy,
        'balance_checked_against_user_id', v_check_user
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