-- Merchant claim / float reservation / funding attribution: stop one merchant's
-- actions landing on another merchant's books.
--
-- There is ONE merchant_float_reservations row per withdrawal. Three functions
-- treated that row as "the caller's" without checking whose it was:
--
--   1. claim_withdrawal_verified reserved float BEFORE checking the row was
--      free, and on losing the race called release_merchant_float(withdrawal)
--      -- which released the WINNER's reservation (released_reason
--      'claim_race_lost' on reservations whose agent actually holds the claim).
--      It also never checked the withdrawal was still open, so a direct RPC
--      could claim (and reserve float against) a completed row.
--   2. reserve_merchant_float returned any non-released reservation as
--      "idempotent", whoever owned it. A merchant settling a withdrawal another
--      merchant had once claimed inherited that merchant's reservation, and it
--      was consumed under the other merchant's name.
--   3. release_stale_cashout_claims returned the row to the pool but left the
--      old merchant's reservation `reserved` (their available float read low for
--      up to 48h, and the next claimer inherited it via 2) and left
--      dispatch_claimed_by set (accept_withdrawal_dispatch then refused every
--      other merchant with 'already_claimed', and the stale stamp is what the
--      proofless-payout banner mis-blamed merchants for).
--
-- 4. classify_merchant_payout_funding took the merchant from that reservation
--    row FIRST, in any state, before looking at who settled. With 1-3 feeding
--    it the wrong owner, it booked the full payout as the reservation holder's
--    own cash and auto-filed a `pending_reimbursement` receivable to them, while
--    the merchant who actually settled (and was paid the 0.5% commission) got
--    none -- approve-withdrawal's own out-of-pocket filing for the settler was
--    then dropped as a duplicate (withdrawal_id, kind). Measured 2026-09-11: 29
--    rows / UGX ~21.3M pending_reimbursement booked to a merchant other than the
--    settler, plus one UGX 2,000,000 already reimbursed that way.
--
-- Per Josh (2026-09-11), those existing receivables are left exactly as they
-- are -- this migration changes no receivable, reservation, ledger or
-- withdrawal row. The classifier now attributes to the settler and, where the
-- claimant and settler disagree, refuses to guess: it leaves any receivable
-- already on file untouched and raises none on its own.


-- ── 1. claim_withdrawal_verified ────────────────────────────────────────────
-- Changes vs live: after taking the row lock, refuse if the row is not open (queue
-- fence) or is claimed by another desk BEFORE reserving float; treat a re-tap on
-- your own claim as success; on the (now defensive-only) lost-race path, release
-- the reservation only if it is the caller's. Everything else is verbatim.
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

  -- The row lock above serialises every claimer of this withdrawal, so these
  -- checks cannot race. They run before any float is reserved.
  IF v_w.assigned_cashout_agent_id = v_agent_id THEN
    RETURN jsonb_build_object('success', true, 'withdrawal_id', p_withdrawal_id,
      'idempotent', true);
  END IF;

  IF v_w.assigned_cashout_agent_id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_claimed',
      'message', 'Already claimed by another agent — refreshing queue.');
  END IF;

  -- Same fence as the merchant queue (src/lib/merchantPayoutQueue.ts).
  IF v_w.status NOT IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved')
     OR v_w.processed_at IS NOT NULL
     OR COALESCE(v_w.fin_ops_reference, '') <> ''
     OR v_w.hidden_from_merchant_queue IS TRUE THEN
    RETURN jsonb_build_object('error', 'not_available', 'status', v_w.status,
      'message', 'This withdrawal is no longer in the payout queue.');
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
    -- Unreachable while the row lock is held; kept as a guard. Only ever
    -- release a reservation that is the caller's own.
    IF EXISTS (
      SELECT 1 FROM public.merchant_float_reservations r
       WHERE r.withdrawal_id = p_withdrawal_id
         AND r.agent_id = auth.uid()
         AND r.state = 'reserved'
    ) THEN
      PERFORM public.release_merchant_float(p_withdrawal_id, 'claim_race_lost');
    END IF;
    RETURN jsonb_build_object('error', 'already_claimed',
      'message', 'Already claimed by another agent — refreshing queue.');
  END IF;

  RETURN jsonb_build_object('success', true, 'withdrawal_id', p_withdrawal_id,
    'reserved_amount', v_reserve->'reserved_amount',
    'planned_out_of_pocket', v_reserve->'planned_out_of_pocket');
END;
$function$;


-- ── 2. reserve_merchant_float ───────────────────────────────────────────────
-- Changes vs live: the idempotent early return now requires the reservation to
-- be the CALLER's (or already consumed, which can never be re-pointed). A live
-- reservation held by another agent is re-pointed to the caller through the
-- existing re-reserve UPDATE path -- by the time this runs, the caller either
-- holds the claim (claim_withdrawal_verified checked the row was free) or is
-- the one actually settling (approve-withdrawal). Everything else is verbatim.
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
  IF FOUND AND v_existing.state <> 'released'
     AND (v_existing.agent_id = v_agent OR v_existing.state = 'consumed') THEN
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
      'available_before', v_available, 'pool_available', v_pool_available,
      'repointed_from', CASE WHEN v_existing.state <> 'released'
                              AND v_existing.agent_id IS DISTINCT FROM v_agent
                             THEN v_existing.agent_id END);
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


-- ── 3. release_stale_cashout_claims ─────────────────────────────────────────
-- Changes vs live: the release also clears dispatch_claimed_by/_at and frees the
-- released rows' still-`reserved` float reservations. The stale/zero-evidence
-- guard (45 minutes, no processing, proof, code or TID) is unchanged, so exactly
-- the same rows are released as before.
CREATE OR REPLACE FUNCTION public.release_stale_cashout_claims()
 RETURNS TABLE(released_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids uuid[];
  v_count integer;
  v_resv integer := 0;
BEGIN
  -- Only release claims that show ZERO settlement progress. If the merchant has
  -- uploaded proof, pasted a payout code / transaction id, or has an in-flight
  -- processing marker, DO NOT return the row to the pool — a second merchant
  -- would otherwise pay the same tenant again ("duplicate reappearing"). The
  -- window is 45 minutes to accommodate real MoMo delays.
  WITH released AS (
    UPDATE public.withdrawal_requests
       SET assigned_cashout_agent_id = NULL,
           dispatched_at = NULL,
           dispatch_claimed_by = NULL,
           dispatch_claimed_at = NULL
     WHERE assigned_cashout_agent_id IS NOT NULL
       AND dispatched_at IS NOT NULL
       AND dispatched_at < (now() - interval '45 minutes')
       AND status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'approved', 'fin_ops_approved')
       AND processing_started_at IS NULL
       AND COALESCE(payout_proof, '') = ''
       AND COALESCE(payout_code, '') = ''
       AND COALESCE(transaction_id, '') = ''
    RETURNING id
  )
  SELECT array_agg(id), count(*) INTO v_ids, v_count FROM released;

  -- The released merchant no longer holds these payouts: free their float so
  -- it is not double-counted and the next claimer gets a fresh reservation.
  IF COALESCE(v_count, 0) > 0 THEN
    WITH r AS (
      UPDATE public.merchant_float_reservations
         SET state = 'released', reserved_amount = 0,
             released_reason = 'stale_claim_released', settled_at = now()
       WHERE withdrawal_id = ANY (v_ids)
         AND state = 'reserved'
      RETURNING 1
    ) SELECT count(*) INTO v_resv FROM r;
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      NULL,
      'cashout_claim_auto_released',
      'withdrawal_requests',
      'cashout_claims',
      jsonb_build_object(
        'released_count', COALESCE(v_count, 0),
        'released_ids', COALESCE(v_ids, ARRAY[]::uuid[]),
        'reservations_released', v_resv,
        'released_at', now(),
        'window_minutes', 45,
        'reason', 'claim exceeded 45 minute payout window with zero settlement progress'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY SELECT COALESCE(v_count, 0);
END;
$function$;


-- ── 4. classify_merchant_payout_funding ─────────────────────────────────────
-- Changes vs live:
--   * Merchant = whoever SETTLED the payout (processed_by, when that is an active
--     cash-out agent -- the same person approve-withdrawal paid the commission
--     to). The reservation holder is only a fallback for rows not yet settled,
--     or a candidate when a non-merchant (FinOps staff) settled.
--   * If the reservation holder and the settler disagree, or a non-merchant
--     settled a claimed payout, the books cannot show who fronted the cash. Any
--     receivable already on file is left EXACTLY as it is (per Josh, 2026-09-11)
--     and no new one is raised; the funding row is marked needs_review.
--   * Telecom coverage uses the real `-merchant-telecom-charge` leg when one
--     exists (the float guard and approve-withdrawal post it again as of
--     20260911180000), falling back to the old proportional estimate.
CREATE OR REPLACE FUNCTION public.classify_merchant_payout_funding(p_withdrawal_id uuid, p_via text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  w record;
  v_agent uuid;
  v_resv_agent uuid;
  v_settler_is_merchant boolean := false;
  v_mismatch boolean := false;
  v_amount numeric := 0;
  v_telecom numeric := 0;
  v_float_principal numeric := 0;
  v_float_telecom numeric := 0;
  v_telecom_leg numeric := 0;
  v_own_principal numeric := 0;
  v_own_telecom numeric := 0;
  v_source text;
  v_receivable numeric := 0;
  v_completed boolean := false;
  v_has_reservation boolean := false;
  v_note text := NULL;
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'withdrawal_not_found');
  END IF;

  SELECT r.agent_id INTO v_resv_agent
  FROM public.merchant_float_reservations r
  WHERE r.withdrawal_id = p_withdrawal_id
  LIMIT 1;

  IF w.processed_by IS NOT NULL THEN
    v_settler_is_merchant := EXISTS (
      SELECT 1 FROM public.cashout_agents ca
       WHERE ca.agent_id = w.processed_by AND ca.is_active = true);
  END IF;

  IF v_settler_is_merchant THEN
    v_agent := w.processed_by;
    v_mismatch := v_resv_agent IS NOT NULL AND v_resv_agent <> w.processed_by;
  ELSE
    v_agent := v_resv_agent;
    IF v_agent IS NULL THEN
      SELECT ca.agent_id INTO v_agent
      FROM public.cashout_agents ca
      WHERE ca.is_active = true
        AND ca.agent_id IN (w.dispatch_claimed_by, w.processed_by, w.processing_started_by)
      LIMIT 1;
    END IF;
    -- Settled, but by someone who is not a merchant: the candidate merchant
    -- never confirmed paying it.
    v_mismatch := w.processed_by IS NOT NULL AND v_agent IS NOT NULL;
  END IF;
  v_has_reservation := v_resv_agent IS NOT NULL AND v_resv_agent = v_agent;

  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'not_a_merchant_payout');
  END IF;

  v_completed := COALESCE(w.status, '') IN ('paid', 'completed');
  v_amount := GREATEST(0, COALESCE(w.amount, 0));
  v_telecom := public.telecom_sending_charge(v_amount);

  SELECT COALESCE(SUM(gl.amount), 0) INTO v_float_principal
  FROM public.general_ledger gl
  WHERE gl.reference_id = p_withdrawal_id::text || '-merchant-float-consume'
    AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out';

  v_float_principal := LEAST(v_float_principal, v_amount);

  -- Claimant and settler disagree: do not guess who fronted the cash.
  IF v_completed AND v_mismatch THEN
    IF EXISTS (SELECT 1 FROM public.merchant_out_of_pocket_advances
                WHERE withdrawal_id = p_withdrawal_id) THEN
      RETURN jsonb_build_object('ok', true, 'withdrawal_id', p_withdrawal_id,
        'skipped', 'attribution_mismatch_existing_receivables_left',
        'settled_by', w.processed_by, 'reservation_agent', v_resv_agent);
    END IF;

    v_note := format(
      'Claimant/settler mismatch: float reservation held by %s, payout settled by %s (%s). '
      'The books cannot show who fronted the cash, so no receivable was raised. Needs finance review.',
      coalesce(v_resv_agent::text, 'nobody'), coalesce(w.processed_by::text, 'nobody'),
      CASE WHEN v_settler_is_merchant THEN 'a merchant' ELSE 'not a merchant' END);

    INSERT INTO public.merchant_payout_funding
      (withdrawal_id, agent_id, payout_amount, telecom_charge_expected,
       float_consumed_principal, float_consumed_telecom, own_cash_principal,
       own_cash_telecom, receivable_recorded, funding_source, classified_via, notes)
    VALUES (p_withdrawal_id, v_agent, v_amount, v_telecom, v_float_principal,
            0, 0, 0, 0, 'needs_review', p_via, v_note)
    ON CONFLICT (withdrawal_id) DO UPDATE
      SET agent_id = EXCLUDED.agent_id,
          payout_amount = EXCLUDED.payout_amount,
          telecom_charge_expected = EXCLUDED.telecom_charge_expected,
          float_consumed_principal = EXCLUDED.float_consumed_principal,
          float_consumed_telecom = 0,
          own_cash_principal = 0,
          own_cash_telecom = 0,
          receivable_recorded = 0,
          funding_source = 'needs_review',
          classified_via = EXCLUDED.classified_via,
          notes = EXCLUDED.notes,
          classified_at = now(),
          updated_at = now();

    RETURN jsonb_build_object('ok', true, 'withdrawal_id', p_withdrawal_id,
      'agent_id', v_agent, 'funding_source', 'needs_review', 'status', w.status,
      'note', v_note);
  END IF;

  SELECT COALESCE(SUM(gl.amount), 0) INTO v_telecom_leg
  FROM public.general_ledger gl
  WHERE gl.reference_id = p_withdrawal_id::text || '-merchant-telecom-charge'
    AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out';

  IF v_telecom_leg > 0 THEN
    v_float_telecom := LEAST(v_telecom, v_telecom_leg);
  ELSIF v_amount > 0 THEN
    -- No telecom leg posted: estimate coverage in the same proportion float
    -- covered the principal (the pre-2026-09-11 behaviour).
    v_float_telecom := LEAST(v_telecom, ROUND(v_telecom * v_float_principal / v_amount));
  ELSE
    v_float_telecom := 0;
  END IF;

  v_own_principal := GREATEST(0, v_amount - v_float_principal);
  v_own_telecom := GREATEST(0, v_telecom - v_float_telecom);

  IF NOT v_completed OR (NOT v_has_reservation AND v_float_principal + v_float_telecom = 0) THEN
    v_source := CASE WHEN NOT v_completed THEN 'unknown' ELSE 'needs_review' END;
    v_note := CASE
      WHEN NOT v_completed
        THEN 'Payout not completed (status=' || COALESCE(w.status,'null') || '); funding source undecided.'
      ELSE 'No float reservation and no float movement on this payout: funding source cannot be proven from the books. Needs finance review before any receivable is raised.'
    END;

    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id
      AND status IN ('pending_reimbursement', 'needs_review')
      AND attested_at IS NULL
      AND reviewed_at IS NULL
      AND note LIKE 'Phase 6 classification:%';

    SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_receivable
    FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id;

    INSERT INTO public.merchant_payout_funding
      (withdrawal_id, agent_id, payout_amount, telecom_charge_expected,
       float_consumed_principal, float_consumed_telecom, own_cash_principal,
       own_cash_telecom, receivable_recorded, funding_source, classified_via, notes)
    VALUES (p_withdrawal_id, v_agent, v_amount, v_telecom, v_float_principal,
            v_float_telecom, 0, 0, v_receivable, v_source, p_via, v_note)
    ON CONFLICT (withdrawal_id) DO UPDATE
      SET agent_id = EXCLUDED.agent_id,
          payout_amount = EXCLUDED.payout_amount,
          telecom_charge_expected = EXCLUDED.telecom_charge_expected,
          float_consumed_principal = EXCLUDED.float_consumed_principal,
          float_consumed_telecom = EXCLUDED.float_consumed_telecom,
          own_cash_principal = 0,
          own_cash_telecom = 0,
          receivable_recorded = EXCLUDED.receivable_recorded,
          funding_source = EXCLUDED.funding_source,
          classified_via = EXCLUDED.classified_via,
          notes = EXCLUDED.notes,
          classified_at = now(),
          updated_at = now();

    RETURN jsonb_build_object('ok', true, 'withdrawal_id', p_withdrawal_id,
      'agent_id', v_agent, 'funding_source', v_source, 'status', w.status,
      'float_consumed_principal', v_float_principal,
      'own_cash_principal', 0, 'own_cash_telecom', 0,
      'receivable_recorded', v_receivable, 'note', v_note);
  END IF;

  v_source := CASE
    WHEN v_amount = 0 THEN 'none'
    WHEN v_float_principal + v_float_telecom = 0 THEN 'own_cash'
    WHEN v_own_principal + v_own_telecom = 0 THEN 'float'
    ELSE 'mixed'
  END;

  IF v_own_principal > 0 THEN
    INSERT INTO public.merchant_out_of_pocket_advances
      (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
       shortfall_amount, status, note)
    VALUES (v_agent, p_withdrawal_id, 'payout', v_amount, v_telecom,
            v_float_principal, ROUND(v_own_principal), 'pending_reimbursement',
            'Phase 6 classification: company float covered UGX ' ||
            ROUND(v_float_principal)::text || ' of UGX ' || ROUND(v_amount)::text ||
            '; UGX ' || ROUND(v_own_principal)::text ||
            ' fronted by the merchant from their own phone and recorded as money the company owes them.')
    ON CONFLICT (withdrawal_id, kind) DO UPDATE
      SET float_used = EXCLUDED.float_used,
          telecom_charge = EXCLUDED.telecom_charge,
          payout_amount = EXCLUDED.payout_amount,
          shortfall_amount = EXCLUDED.shortfall_amount,
          status = EXCLUDED.status,
          note = EXCLUDED.note,
          updated_at = now()
      WHERE public.merchant_out_of_pocket_advances.status IN ('pending_reimbursement', 'needs_review')
        AND public.merchant_out_of_pocket_advances.attested_at IS NULL
        AND public.merchant_out_of_pocket_advances.reviewed_at IS NULL;
  ELSE
    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id AND kind = 'payout'
      AND status IN ('pending_reimbursement', 'needs_review')
      AND attested_at IS NULL
      AND reviewed_at IS NULL;
  END IF;

  IF v_own_telecom > 0 THEN
    INSERT INTO public.merchant_out_of_pocket_advances
      (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
       shortfall_amount, status, note)
    VALUES (v_agent, p_withdrawal_id, 'telecom', v_amount, v_telecom,
            v_float_telecom, ROUND(v_own_telecom), 'pending_reimbursement',
            'Phase 6 classification: company float covered UGX ' ||
            ROUND(v_float_telecom)::text || ' of the UGX ' || ROUND(v_telecom)::text ||
            ' telecom fee. UGX ' || ROUND(v_own_telecom)::text ||
            ' fronted by the merchant from their own phone and recorded as money the company owes them.')
    ON CONFLICT (withdrawal_id, kind) DO UPDATE
      SET float_used = EXCLUDED.float_used,
          telecom_charge = EXCLUDED.telecom_charge,
          payout_amount = EXCLUDED.payout_amount,
          shortfall_amount = EXCLUDED.shortfall_amount,
          status = EXCLUDED.status,
          note = EXCLUDED.note,
          updated_at = now()
      WHERE public.merchant_out_of_pocket_advances.status IN ('pending_reimbursement', 'needs_review')
        AND public.merchant_out_of_pocket_advances.attested_at IS NULL
        AND public.merchant_out_of_pocket_advances.reviewed_at IS NULL;
  ELSE
    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id AND kind = 'telecom'
      AND status IN ('pending_reimbursement', 'needs_review')
      AND attested_at IS NULL
      AND reviewed_at IS NULL;
  END IF;

  SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_receivable
  FROM public.merchant_out_of_pocket_advances
  WHERE withdrawal_id = p_withdrawal_id;

  INSERT INTO public.merchant_payout_funding
    (withdrawal_id, agent_id, payout_amount, telecom_charge_expected,
     float_consumed_principal, float_consumed_telecom, own_cash_principal,
     own_cash_telecom, receivable_recorded, funding_source, classified_via, notes)
  VALUES (p_withdrawal_id, v_agent, v_amount, v_telecom, v_float_principal,
          v_float_telecom, ROUND(v_own_principal), ROUND(v_own_telecom),
          v_receivable, v_source, p_via, NULL)
  ON CONFLICT (withdrawal_id) DO UPDATE
    SET agent_id = EXCLUDED.agent_id,
        payout_amount = EXCLUDED.payout_amount,
        telecom_charge_expected = EXCLUDED.telecom_charge_expected,
        float_consumed_principal = EXCLUDED.float_consumed_principal,
        float_consumed_telecom = EXCLUDED.float_consumed_telecom,
        own_cash_principal = EXCLUDED.own_cash_principal,
        own_cash_telecom = EXCLUDED.own_cash_telecom,
        receivable_recorded = EXCLUDED.receivable_recorded,
        funding_source = EXCLUDED.funding_source,
        classified_via = EXCLUDED.classified_via,
        notes = NULL,
        classified_at = now(),
        updated_at = now();

  UPDATE public.merchant_float_reservations
     SET consumed_float = v_float_principal,
         consumed_telecom = v_float_telecom,
         out_of_pocket_amount = ROUND(v_own_principal + v_own_telecom),
         updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id
     AND agent_id = v_agent;

  RETURN jsonb_build_object(
    'ok', true, 'withdrawal_id', p_withdrawal_id, 'agent_id', v_agent,
    'funding_source', v_source, 'payout_amount', v_amount,
    'telecom_charge_expected', v_telecom,
    'float_consumed_principal', v_float_principal,
    'float_consumed_telecom', v_float_telecom,
    'own_cash_principal', ROUND(v_own_principal),
    'own_cash_telecom', ROUND(v_own_telecom),
    'receivable_recorded', v_receivable);
END;
$function$;
