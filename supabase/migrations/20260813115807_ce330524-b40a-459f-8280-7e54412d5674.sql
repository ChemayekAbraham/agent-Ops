-- Remove the hardcoded UGX 500,000 out-of-pocket ceiling.
-- The allowance is now purely a treasury setting; unset/empty means "none",
-- so claim decisions are driven by real available float, at any payout size.

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

  PERFORM 1 FROM public.wallets_physical WHERE user_id = v_agent FOR UPDATE;

  SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_float
  FROM public.wallets WHERE user_id = v_agent;
  v_float := COALESCE(v_float, 0);

  v_reserved := public.merchant_reserved_float(v_agent);
  v_available := GREATEST(v_float - v_reserved, 0);
  v_need := v_amount + v_telecom;
  v_reserve := LEAST(v_available, v_need);
  v_planned_oop := GREATEST(v_need - v_reserve, 0);

  -- Optional own-money allowance. Unset / empty => none. There is no
  -- hardcoded transactional ceiling: payout size itself is never capped.
  SELECT COALESCE(NULLIF(btrim(value), '')::numeric, 0) INTO v_headroom
  FROM public.treasury_controls WHERE control_key = 'merchant_out_of_pocket_headroom';
  v_headroom := GREATEST(COALESCE(v_headroom, 0), 0);

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

-- Reported headroom must mirror the same rule (no 500,000 default).
CREATE OR REPLACE FUNCTION public.get_merchant_float_position(p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_float numeric := 0;
  v_reserved numeric := 0;
  v_oop numeric := 0;
  v_oop_review numeric := 0;
  v_headroom numeric := 0;
BEGIN
  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('error', 'no_agent');
  END IF;

  SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_float
  FROM public.wallets WHERE user_id = v_agent;
  v_float := COALESCE(v_float, 0);

  v_reserved := public.merchant_reserved_float(v_agent);

  SELECT
    COALESCE(SUM(CASE WHEN status IN ('outstanding', 'confirmed', 'approved')
                      THEN outstanding_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status = 'needs_review'
                      THEN outstanding_amount ELSE 0 END), 0)
    INTO v_oop, v_oop_review
  FROM public.merchant_out_of_pocket_advances
  WHERE agent_id = v_agent;

  SELECT COALESCE(NULLIF(btrim(value), '')::numeric, 0) INTO v_headroom
  FROM public.treasury_controls WHERE control_key = 'merchant_out_of_pocket_headroom';
  v_headroom := GREATEST(COALESCE(v_headroom, 0), 0);

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'float_balance', v_float,
    'reserved_float', v_reserved,
    'available_float', GREATEST(v_float - v_reserved, 0),
    'out_of_pocket_outstanding', v_oop,
    'out_of_pocket_under_review', v_oop_review,
    'out_of_pocket_headroom', v_headroom
  );
END;
$function$;