-- The 2026-07-24 payouts_ui_enabled freeze (enforce_payouts_ui_flag_on_withdrawals)
-- only guards INSERT on withdrawal_requests -- it stops new withdrawal requests
-- from being created, but says nothing about claim_withdrawal_verified(), which
-- lets a Merchant Agent claim and pay out a request that already existed in the
-- queue before the freeze went on. Found 2026-09-16: while payouts_ui_enabled
-- was off, 7 pre-existing ordinary withdrawal requests were still claimed and 8
-- processed (UGX 2,168,786) through this path. Landlord/proxy-partner payouts
-- are deliberately exempt from the freeze (same as the INSERT trigger) and stay
-- exempt here -- confirmed with Josh this is intentional, not part of the gap.
create or replace function public.claim_withdrawal_verified(p_withdrawal_id uuid, p_momo_number text DEFAULT NULL::text, p_momo_name text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c_open   CONSTANT text[] := ARRAY['pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved'];
  -- "Claimed by you" also keeps legacy 'approved' claims open.
  c_active CONSTANT text[] := ARRAY['pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved', 'approved'];
  v_uid uuid := auth.uid();
  v_desk uuid;
  v_w public.withdrawal_requests%ROWTYPE;
  v_res public.merchant_float_reservations%ROWTYPE;
  v_reserve jsonb;
  v_block uuid;
  v_active_claim uuid;
  v_is_momo boolean;
  v_stored_num text;
  v_in_num text;
  v_stored_name text;
  v_in_name text;
  v_outcome text := 'none';
  v_payload jsonb;
  v_msg text;
  v_detail text;
  v_payouts_ui_enabled boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN public.merchant_claim_fail(p_withdrawal_id, NULL, NULL, 'CLAIM_PERMISSION_DENIED',
      'not_authenticated', 'Your session has expired. Sign in again to claim payouts.');
  END IF;

  SELECT id INTO v_desk
  FROM public.cashout_agents
  WHERE agent_id = v_uid AND is_active = true
  ORDER BY created_at, id
  LIMIT 1;

  IF v_desk IS NULL THEN
    RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, NULL, 'CLAIM_PERMISSION_DENIED',
      'not_cashout_agent', 'You are not an active Merchant Agent.');
  END IF;

  -- Serialise this merchant's own claim attempts (double tap / retry storms).
  PERFORM pg_advisory_xact_lock(hashtext('cashout_claim:' || v_desk::text));

  -- Lock the withdrawal BEFORE any money state is touched. Every claimer of
  -- this row queues here; whoever is second sees the first one's committed
  -- assignment and is classified below without reserving anything.
  SELECT * INTO v_w FROM public.withdrawal_requests WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_NOT_ACTIONABLE',
      'not_found', 'Withdrawal not found.');
  END IF;

  -- Payout freeze: same exemption as enforce_payouts_ui_flag_on_withdrawals
  -- (landlord/proxy-partner payouts stay exempt). Everything else is blocked
  -- from being claimed or continued while the CTO's Claim & Withdraw toggle
  -- is off, not just blocked from being newly created.
  IF v_w.landlord_payout_id IS NULL AND v_w.proxy_partner_id IS NULL THEN
    SELECT enabled INTO v_payouts_ui_enabled
    FROM public.treasury_controls
    WHERE control_key = 'payouts_ui_enabled'
    LIMIT 1;

    IF COALESCE(v_payouts_ui_enabled, false) = false THEN
      RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_NOT_ACTIONABLE',
        'payouts_frozen', 'Withdrawals are temporarily disabled by platform administrators. Please try again later.');
    END IF;
  END IF;

  -- ID-verification gate: withdrawals from customers who have not completed
  -- ID verification are invisible to merchant agents and cannot be claimed.
  IF NOT public.withdrawal_merchant_id_gate(v_w.user_id, v_w.landlord_payout_id, v_w.reason) THEN
    RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_NOT_ACTIONABLE',
      'id_not_verified', 'This customer has not completed ID verification. This payout is not available to Merchant Agents.');
  END IF;

  -- A. Already this merchant's claim: idempotent success. Never reserves again
  --    and never releases, unless the reservation is missing/dead (legacy rows
  --    the old RPC damaged), in which case it is re-established for the owner.
  IF v_w.assigned_cashout_agent_id = v_desk THEN
    IF NOT (v_w.status = ANY (c_active))
       OR v_w.processed_at IS NOT NULL
       OR COALESCE(v_w.fin_ops_reference, '') <> '' THEN
      RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_NOT_ACTIONABLE',
        'not_available', 'This payout is already closed.');
    END IF;

    SELECT * INTO v_res FROM public.merchant_float_reservations
    WHERE withdrawal_id = p_withdrawal_id FOR UPDATE;

    IF v_res.id IS NOT NULL AND v_res.agent_id = v_uid AND v_res.state IN ('reserved', 'consumed') THEN
      v_outcome := 'kept_existing';
    ELSIF v_res.id IS NOT NULL AND v_res.state = 'consumed' THEN
      v_outcome := 'consumed_by_other_left_untouched';
    ELSE
      BEGIN
        IF v_res.id IS NOT NULL AND v_res.state = 'reserved' THEN
          PERFORM public.release_merchant_float(p_withdrawal_id, 'repointed_to_claim_owner');
        END IF;
        v_reserve := public.reserve_merchant_float(p_withdrawal_id, v_uid);
        IF v_reserve ? 'error' THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reserve:' || (v_reserve->>'error');
        END IF;
        v_outcome := 'restored_for_owner';
      EXCEPTION WHEN OTHERS THEN
        -- The claim is already this merchant's; report, do not revoke it.
        v_outcome := 'restore_failed:' || SQLERRM;
      END;
    END IF;

    PERFORM public.merchant_claim_log(p_withdrawal_id, v_uid, v_desk, 'CLAIM_ALREADY_OWNED_BY_SELF',
      NULL, true, false, NULL, v_outcome, NULL);
    v_payload := public.merchant_claim_payload(p_withdrawal_id);
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'already_owned_by_you', true,
      'result_code', 'CLAIM_ALREADY_OWNED_BY_SELF',
      'message', 'This payout is already yours.',
      'withdrawal_id', p_withdrawal_id,
      'reservation_outcome', v_outcome,
      'reserved_amount', v_payload->'reservation'->'reserved_amount',
      'planned_out_of_pocket', v_payload->'reservation'->'planned_out_of_pocket'
    ) || v_payload;
  END IF;

  -- B. Another merchant holds it. Nothing is reserved or released.
  IF v_w.assigned_cashout_agent_id IS NOT NULL THEN
    RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_ALREADY_OWNED_BY_OTHER',
      'already_claimed', 'This withdrawal was claimed by another Merchant Agent.', NULL, true);
  END IF;

  -- C. Same fence as the merchant queue (src/lib/merchantPayoutQueue.ts).
  IF NOT (v_w.status = ANY (c_open))
     OR v_w.processed_at IS NOT NULL
     OR COALESCE(v_w.fin_ops_reference, '') <> ''
     OR v_w.hidden_from_merchant_queue IS TRUE THEN
    RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_NOT_ACTIONABLE',
      'not_available', 'This withdrawal is no longer in the payout queue.');
  END IF;

  -- D. One active claim per merchant (a retry of the SAME row returned in A).
  SELECT w.id INTO v_active_claim
  FROM public.withdrawal_requests w
  WHERE w.assigned_cashout_agent_id = v_desk
    AND w.id <> p_withdrawal_id
    AND w.status = ANY (c_active)
    AND w.processed_at IS NULL
    AND COALESCE(w.fin_ops_reference, '') = ''
  ORDER BY w.dispatched_at NULLS FIRST
  LIMIT 1;

  IF v_active_claim IS NOT NULL THEN
    RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_BLOCKED_ACTIVE_CLAIM',
      'active_claim_exists', 'You already have a payout in progress. Finish it before claiming another.',
      v_active_claim);
  END IF;

  -- E. Channel / category permission: the same predicate the
  --    enforce_merchant_payout_authorization trigger applies on assignment,
  --    checked up front so the merchant gets a clear answer.
  IF NOT public.merchant_agent_allows_withdrawal(
       v_desk, v_w.reason, v_w.payout_method, v_w.bank_name, v_w.mobile_money_provider) THEN
    RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_PERMISSION_DENIED',
      'not_authorized_for_payout', 'This payout is outside the payment channels / payout categories assigned to you.');
  END IF;

  -- F. Priority holds (unchanged rules).
  v_block := public.assert_no_urgent_landlord_priority(p_withdrawal_id);
  IF v_block IS NOT NULL THEN
    RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_PRIORITY_BLOCKED',
      'landlord_priority_hold', 'A Priority Landlord payout must be processed first. Claim that payout before any other.',
      v_block);
  END IF;

  v_block := public.assert_no_urgent_proxy_priority(p_withdrawal_id);
  IF v_block IS NOT NULL THEN
    RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_PRIORITY_BLOCKED',
      'proxy_priority_hold', 'A Priority Proxy Agent withdrawal must be processed first. Claim that payout before any other.',
      v_block);
  END IF;

  -- G. Mobile Money payout-detail check (unchanged rules).
  v_is_momo := COALESCE(v_w.payout_method, '') IN ('mobile_money', 'mtn_mobile_money', 'airtel_money');
  IF v_is_momo THEN
    v_stored_num := regexp_replace(COALESCE(v_w.mobile_money_number, ''), '\D', '', 'g');
    v_in_num     := regexp_replace(COALESCE(p_momo_number, ''), '\D', '', 'g');
    IF length(v_stored_num) >= 9 THEN v_stored_num := right(v_stored_num, 9); END IF;
    IF length(v_in_num) >= 9 THEN v_in_num := right(v_in_num, 9); END IF;

    IF v_stored_num = '' THEN
      RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_DETAILS_MISMATCH',
        'no_stored_number', 'This withdrawal has no stored Mobile Money number to verify against.');
    END IF;

    IF v_in_num = '' OR v_in_num <> v_stored_num THEN
      RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_DETAILS_MISMATCH',
        'number_mismatch', 'The Mobile Money number being claimed does not match the stored payout number.');
    END IF;

    v_stored_name := COALESCE(v_w.mobile_money_name, '');
    IF v_stored_name <> '' THEN
      v_in_name := btrim(regexp_replace(
        regexp_replace(lower(COALESCE(p_momo_name, '')), '[^a-z0-9 ]', '', 'g'), '\s+', ' ', 'g'));
      v_stored_name := btrim(regexp_replace(
        regexp_replace(lower(v_stored_name), '[^a-z0-9 ]', '', 'g'), '\s+', ' ', 'g'));
      IF v_in_name = '' OR v_in_name <> v_stored_name THEN
        RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_DETAILS_MISMATCH',
          'name_mismatch', 'The registered Mobile Money name being claimed does not match the stored payout name.');
      END IF;
    END IF;
  END IF;

  -- H. Reserve + assign as ONE unit. The inner block is a savepoint: any
  --    failure rolls back both, so there is never a reservation without the
  --    assignment or an assignment without the reservation.
  BEGIN
    SELECT * INTO v_res FROM public.merchant_float_reservations
    WHERE withdrawal_id = p_withdrawal_id FOR UPDATE;

    IF v_res.id IS NOT NULL AND v_res.state = 'consumed' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reserve:reservation_already_consumed',
        DETAIL = 'This payout already has settled float against it. Ask Financial Operations to review it.';
    END IF;

    IF v_res.id IS NOT NULL AND v_res.state = 'reserved' THEN
      -- A reservation left behind on a row nobody holds (e.g. a claim that was
      -- returned to the queue). It cannot belong to a live claim -- the row is
      -- unassigned and locked -- so free it before reserving for this claim.
      PERFORM public.release_merchant_float(p_withdrawal_id, 'orphan_released_on_new_claim');
      v_outcome := 'orphan_released_then_reserved';
    ELSE
      v_outcome := 'reserved';
    END IF;

    v_reserve := public.reserve_merchant_float(p_withdrawal_id, v_uid);
    IF v_reserve ? 'error' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reserve:' || (v_reserve->>'error'),
        DETAIL = COALESCE(v_reserve->>'message', '');
    END IF;

    UPDATE public.withdrawal_requests
       SET assigned_cashout_agent_id = v_desk,
           dispatched_at = now(),
           dispatch_claimed_by = v_uid,
           dispatch_claimed_at = now(),
           dispatch_expires_at = NULL
     WHERE id = p_withdrawal_id
       AND assigned_cashout_agent_id IS NULL;

    IF NOT FOUND THEN
      -- Unreachable while the row lock is held; rolls the reservation back too.
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'assign_failed';
    END IF;

    -- Invariant: the winning claim owns a live reservation.
    PERFORM 1 FROM public.merchant_float_reservations r
    WHERE r.withdrawal_id = p_withdrawal_id AND r.agent_id = v_uid AND r.state = 'reserved';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invariant:reservation_not_owned_by_claimant';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    IF v_msg LIKE 'reserve:%' THEN
      RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_RESERVATION_FAILED',
        substr(v_msg, 9),
        COALESCE(NULLIF(v_detail, ''), 'Your payout float could not be reserved. Nothing was claimed.'),
        NULL, false, v_msg, 'rolled_back');
    ELSIF v_msg ILIKE '%not authorized%' OR v_msg ILIKE '%outside your authorized%' THEN
      RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_PERMISSION_DENIED',
        'not_authorized_for_payout', v_msg, NULL, false, v_msg, 'rolled_back');
    ELSE
      RETURN public.merchant_claim_fail(p_withdrawal_id, v_uid, v_desk, 'CLAIM_FAILED',
        'claim_failed', 'The claim could not be completed. Nothing was reserved or assigned — you can retry.',
        NULL, false, v_msg, 'rolled_back');
    END IF;
  END;

  PERFORM public.merchant_claim_log(p_withdrawal_id, v_uid, v_desk, 'CLAIM_SUCCESS',
    NULL, false, false, NULL, v_outcome, NULL);
  v_payload := public.merchant_claim_payload(p_withdrawal_id);
  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'already_owned_by_you', false,
    'result_code', 'CLAIM_SUCCESS',
    'message', 'Withdrawal claimed.',
    'withdrawal_id', p_withdrawal_id,
    'reservation_outcome', v_outcome,
    'reserved_amount', v_reserve->'reserved_amount',
    'planned_out_of_pocket', v_reserve->'planned_out_of_pocket'
  ) || v_payload;
END;
$function$;
