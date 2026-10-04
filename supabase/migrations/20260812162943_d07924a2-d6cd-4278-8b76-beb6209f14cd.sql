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
  v_headroom numeric := 0;
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

  -- `wallets` is a VIEW over wallets_physical LEFT JOIN wallet_balances_projection,
  -- so FOR UPDATE cannot be applied to it. Lock the physical wallet row instead to
  -- serialise concurrent reservations for the same agent, then read the balance.
  PERFORM 1 FROM public.wallets_physical WHERE user_id = v_agent FOR UPDATE;

  SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_float
  FROM public.wallets WHERE user_id = v_agent;
  v_float := COALESCE(v_float, 0);

  v_reserved := public.merchant_reserved_float(v_agent);
  v_available := GREATEST(v_float - v_reserved, 0);
  v_need := v_amount + v_telecom;
  v_reserve := LEAST(v_available, v_need);
  v_planned_oop := GREATEST(v_need - v_reserve, 0);

  SELECT COALESCE(NULLIF(value, '')::numeric, 500000) INTO v_headroom
  FROM public.treasury_controls WHERE control_key = 'merchant_out_of_pocket_headroom';
  v_headroom := COALESCE(v_headroom, 500000);

  IF v_planned_oop > v_headroom THEN
    RETURN jsonb_build_object(
      'error', 'float_overcommitted',
      'message', format(
        'This payout needs UGX %s but only UGX %s float is available (UGX %s already reserved by claims). Ask Finance for float before claiming.',
        to_char(v_need, 'FM999,999,999'),
        to_char(v_available, 'FM999,999,999'),
        to_char(v_reserved, 'FM999,999,999')),
      'needed', v_need, 'available_float', v_available,
      'reserved_float', v_reserved, 'headroom', v_headroom);
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
      'available_before', v_available);
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
    'float_before', v_float);
END;
$function$;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'release_phantom_lock'
  LIMIT 1;

  IF v_def IS NOT NULL AND v_def ILIKE '%FROM public.wallets WHERE user_id = _user_id FOR UPDATE%' THEN
    v_def := replace(v_def,
      'FROM public.wallets WHERE user_id = _user_id FOR UPDATE',
      'FROM public.wallets WHERE user_id = _user_id');
    v_def := replace(v_def,
      'SELECT id, locked_balance INTO v_wallet_id, v_locked',
      'PERFORM 1 FROM public.wallets_physical WHERE user_id = _user_id FOR UPDATE;
  SELECT id, locked_balance INTO v_wallet_id, v_locked');
    EXECUTE v_def;
  END IF;
END;
$$;