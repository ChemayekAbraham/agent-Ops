-- Claim gate switches from the agent's OWN float to the shared company payout
-- pool. As long as the company pool covers the payout, any merchant agent may
-- claim and process it, even with little or no float on their own line. Any
-- shortfall is still recorded as planned out-of-pocket and lands in the
-- "Awaiting finance review" list at settlement (needs_review), never as
-- silent debt.
CREATE OR REPLACE FUNCTION public.reserve_merchant_float(p_withdrawal_id uuid, p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_desk uuid;
  v_amount numeric := 0;
  v_telecom numeric := 0;
  v_float numeric := 0;
  v_reserved numeric := 0;
  v_available numeric := 0;
  v_need numeric := 0;
  v_reserve numeric := 0;
  v_planned_oop numeric := 0;
  v_pool_withdrawable numeric := 0;
  v_pool_landlord numeric := 0;
  v_pool_claimed numeric := 0;
  v_pool_available numeric := 0;
  v_existing public.merchant_float_reservations;
BEGIN
  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('error', 'no_agent');
  END IF;

  SELECT * INTO v_existing FROM public.merchant_float_reservations
  WHERE withdrawal_id = p_withdrawal_id FOR UPDATE;
  IF FOUND AND v_existing.state <> 'released' THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true,
      'reservation_id', v_existing.id, 'state', v_existing.state,
      'reserved_amount', v_existing.reserved_amount);
  END IF;

  SELECT id INTO v_desk FROM public.cashout_agents
  WHERE agent_id = v_agent AND is_active IS TRUE LIMIT 1;

  SELECT amount INTO v_amount FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF v_amount IS NULL THEN
    RETURN jsonb_build_object('error', 'withdrawal_not_found');
  END IF;

  v_telecom := public.merchant_telecom_sending_charge(v_amount);

  PERFORM 1 FROM public.wallets_physical WHERE user_id = v_agent FOR UPDATE;

  SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_float
  FROM public.wallets WHERE user_id = v_agent;
  v_float := COALESCE(v_float, 0);

  v_reserved := public.merchant_reserved_float(v_agent);
  v_available := GREATEST(v_float - v_reserved, 0);
  v_need := v_amount + v_telecom;
  v_reserve := LEAST(v_available, v_need);
  v_planned_oop := GREATEST(v_need - v_reserve, 0);

  -- Company payout pool (same definition as get_merchant_payout_float).
  IF v_planned_oop > 0 THEN
    SELECT COALESCE(SUM(GREATEST(withdrawable_balance, 0)), 0) INTO v_pool_withdrawable FROM public.wallets;
    SELECT COALESCE(SUM(GREATEST(balance, 0)), 0) INTO v_pool_landlord FROM public.agent_landlord_float;
    SELECT COALESCE(SUM(amount), 0) INTO v_pool_claimed
    FROM public.withdrawal_requests
    WHERE status NOT IN ('completed', 'rejected', 'cancelled', 'failed', 'reversed')
      AND id <> p_withdrawal_id
      AND (assigned_cashout_agent_id IS NOT NULL OR dispatch_claimed_by IS NOT NULL);
    v_pool_available := GREATEST(v_pool_withdrawable + v_pool_landlord - v_pool_claimed, 0);

    IF v_need > v_pool_available THEN
      RETURN jsonb_build_object(
        'error', 'pool_exhausted',
        'message', format(
          'This payout needs UGX %s but the company payout pool only has UGX %s left (UGX %s already committed to claims).',
          to_char(v_need, 'FM999,999,999'),
          to_char(v_pool_available, 'FM999,999,999'),
          to_char(v_pool_claimed, 'FM999,999,999')),
        'needed', v_need, 'pool_available', v_pool_available,
        'available_float', v_available, 'reserved_float', v_reserved);
    END IF;
  END IF;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.merchant_float_reservations SET
      agent_id = v_agent, desk_id = v_desk, state = 'reserved',
      amount_requested = v_amount, telecom_expected = v_telecom,
      float_before = v_float, reserved_before = v_reserved,
      available_before = v_available, reserved_amount = v_reserve,
      planned_out_of_pocket = v_planned_oop, released_reason = NULL,
      reserved_at = now(), settled_at = NULL
    WHERE id = v_existing.id;
    RETURN jsonb_build_object('success', true, 'reservation_id', v_existing.id,
      'reserved_amount', v_reserve, 'planned_out_of_pocket', v_planned_oop,
      'available_before', v_available, 'pool_available', v_pool_available);
  END IF;

  INSERT INTO public.merchant_float_reservations (
    withdrawal_id, agent_id, desk_id, state, amount_requested, telecom_expected,
    float_before, reserved_before, available_before, reserved_amount, planned_out_of_pocket
  ) VALUES (
    p_withdrawal_id, v_agent, v_desk, 'reserved', v_amount, v_telecom,
    v_float, v_reserved, v_available, v_reserve, v_planned_oop
  );

  RETURN jsonb_build_object('success', true, 'reserved_amount', v_reserve,
    'planned_out_of_pocket', v_planned_oop, 'available_before', v_available,
    'float_before', v_float, 'pool_available', v_pool_available);
END;
$function$;