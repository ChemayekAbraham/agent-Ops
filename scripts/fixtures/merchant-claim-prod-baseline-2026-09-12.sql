-- Verbatim production definitions captured 2026-09-12 00:40 EAT via pg_get_functiondef.
-- Used by the test harness as the starting state, and as the ROLLBACK for
-- 20260912010000_canonical_merchant_claim.sql (re-run the two claim functions
-- below to restore the pre-migration behaviour exactly).

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

-- ── ROLLBACK SECTION: previous claim_withdrawal_verified ──
CREATE OR REPLACE FUNCTION public.claim_withdrawal_verified(p_withdrawal_id uuid, p_momo_number text DEFAULT NULL::text, p_momo_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id uuid;
  v_w withdrawal_requests%ROWTYPE;
  v_is_momo boolean;
  v_stored_num text;
  v_in_num text;
  v_stored_name text;
  v_in_name text;
  v_reserve jsonb;
  v_block uuid;
  v_active_claim uuid;
BEGIN
  SELECT id INTO v_agent_id
  FROM cashout_agents
  WHERE agent_id = auth.uid() AND is_active = true
  LIMIT 1;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_cashout_agent',
      'message', 'You are not an active cash-out agent.');
  END IF;

  -- Serialise this merchant's own claim attempts for the life of the transaction.
  PERFORM pg_advisory_xact_lock(hashtext('cashout_claim:' || v_agent_id::text));

  -- ONE ACTIVE CLAIM PER MERCHANT. Only genuinely open, unsettled rows count:
  -- terminal statuses and rows carrying settlement evidence (processed_at /
  -- fin_ops_reference) are ignored, mirroring the merchant queue fence.
  SELECT w.id INTO v_active_claim
  FROM withdrawal_requests w
  WHERE w.assigned_cashout_agent_id = v_agent_id
    AND w.id <> p_withdrawal_id
    AND w.status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'approved', 'fin_ops_approved')
    AND w.processed_at IS NULL
    AND COALESCE(w.fin_ops_reference, '') = ''
  ORDER BY w.dispatched_at NULLS FIRST
  LIMIT 1;

  IF v_active_claim IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'active_claim_exists',
      'blocking_withdrawal_id', v_active_claim,
      'message', 'You already have a payout in progress. Finish or cancel your current claim before claiming another.');
  END IF;

  SELECT * INTO v_w FROM withdrawal_requests WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found',
      'message', 'Withdrawal not found.');
  END IF;

  v_block := public.assert_no_urgent_landlord_priority(p_withdrawal_id);
  IF v_block IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'landlord_priority_hold',
      'blocking_withdrawal_id', v_block,
      'message', 'A Priority Landlord payout must be processed first. Claim that payout before any other.');
  END IF;

  v_block := public.assert_no_urgent_proxy_priority(p_withdrawal_id);
  IF v_block IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'proxy_priority_hold',
      'blocking_withdrawal_id', v_block,
      'message', 'A Priority Proxy Agent withdrawal must be processed first. Claim that payout before any other.');
  END IF;

  v_is_momo := COALESCE(v_w.payout_method, '') IN
    ('mobile_money', 'mtn_mobile_money', 'airtel_money');

  IF v_is_momo THEN
    v_stored_num := regexp_replace(COALESCE(v_w.mobile_money_number, ''), '\D', '', 'g');
    v_in_num     := regexp_replace(COALESCE(p_momo_number, ''), '\D', '', 'g');
    IF length(v_stored_num) >= 9 THEN v_stored_num := right(v_stored_num, 9); END IF;
    IF length(v_in_num) >= 9 THEN v_in_num := right(v_in_num, 9); END IF;

    IF v_stored_num = '' THEN
      RETURN jsonb_build_object('error', 'no_stored_number',
        'message', 'This withdrawal has no stored Mobile Money number to verify against.');
    END IF;

    IF v_in_num IS NULL OR v_in_num = '' OR v_in_num <> v_stored_num THEN
      RETURN jsonb_build_object('error', 'number_mismatch',
        'message', 'The Mobile Money number being claimed does not match the stored payout number.');
    END IF;

    v_stored_name := COALESCE(v_w.mobile_money_name, '');
    IF v_stored_name <> '' THEN
      v_in_name := btrim(regexp_replace(
        regexp_replace(lower(COALESCE(p_momo_name, '')), '[^a-z0-9 ]', '', 'g'),
        '\s+', ' ', 'g'));
      v_stored_name := btrim(regexp_replace(
        regexp_replace(lower(v_stored_name), '[^a-z0-9 ]', '', 'g'),
        '\s+', ' ', 'g'));

      IF v_in_name = '' OR v_in_name <> v_stored_name THEN
        RETURN jsonb_build_object('error', 'name_mismatch',
          'message', 'The registered Mobile Money name being claimed does not match the stored payout name.');
      END IF;
    END IF;
  END IF;

  v_reserve := public.reserve_merchant_float(p_withdrawal_id, auth.uid());
  IF (v_reserve ? 'error') THEN
    RETURN v_reserve;
  END IF;

  UPDATE withdrawal_requests
  SET assigned_cashout_agent_id = v_agent_id,
      dispatched_at = now()
  WHERE id = p_withdrawal_id
    AND assigned_cashout_agent_id IS NULL;

  IF NOT FOUND THEN
    PERFORM public.release_merchant_float(p_withdrawal_id, 'claim_race_lost');
    RETURN jsonb_build_object('error', 'already_claimed',
      'message', 'Already claimed by another agent — refreshing queue.');
  END IF;

  RETURN jsonb_build_object('success', true, 'withdrawal_id', p_withdrawal_id,
    'reserved_amount', v_reserve->'reserved_amount',
    'planned_out_of_pocket', v_reserve->'planned_out_of_pocket');
END;
$function$;

-- ── ROLLBACK SECTION: previous accept_withdrawal_dispatch ──
CREATE OR REPLACE FUNCTION public.accept_withdrawal_dispatch(p_withdrawal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id uuid := auth.uid();
  v_row public.withdrawal_requests%ROWTYPE;
  v_open_statuses text[] := ARRAY['pending','requested','manager_approved','cfo_approved','fin_ops_approved'];
  v_block uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cashout_agents
     WHERE agent_id = v_agent_id AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_merchant_agent');
  END IF;

  SELECT * INTO v_row
    FROM public.withdrawal_requests
   WHERE id = p_withdrawal_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  v_block := public.assert_no_urgent_landlord_priority(p_withdrawal_id);
  IF v_block IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'landlord_priority_hold',
      'blocking_withdrawal_id', v_block,
      'message', 'A Priority Landlord payout must be processed first.');
  END IF;

  v_block := public.assert_no_urgent_proxy_priority(p_withdrawal_id);
  IF v_block IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'proxy_priority_hold',
      'blocking_withdrawal_id', v_block,
      'message', 'A Priority Proxy Agent withdrawal must be processed first.');
  END IF;

  IF NOT public.merchant_handles_payout(
       v_agent_id, v_row.payout_method, v_row.mobile_money_provider, v_row.bank_name
     ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'provider_not_assigned');
  END IF;

  IF v_row.dispatch_claimed_by IS NOT NULL AND v_row.dispatch_claimed_by <> v_agent_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_claimed');
  END IF;

  IF NOT (v_row.status = ANY (v_open_statuses)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_available', 'status', v_row.status);
  END IF;

  UPDATE public.withdrawal_requests
     SET dispatch_claimed_by = v_agent_id,
         dispatch_claimed_at = now(),
         assigned_cashout_agent_id = COALESCE(assigned_cashout_agent_id,
           (SELECT id FROM public.cashout_agents WHERE agent_id = v_agent_id LIMIT 1)),
         updated_at = now()
   WHERE id = p_withdrawal_id;

  UPDATE public.withdrawal_notification_log
     SET response = 'accepted', claimed_at = now(), updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id AND recipient_id = v_agent_id;

  UPDATE public.withdrawal_notification_log
     SET response = 'superseded', claimed_at = now(), updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id
     AND recipient_id <> v_agent_id
     AND response = 'pending';

  RETURN jsonb_build_object('ok', true, 'withdrawal_id', p_withdrawal_id);
END;
$function$;
