-- Canonical Merchant Agent claim transaction (payouts rebuild, Prompt 1: CLAIM ONLY).
--
-- Incident (production, 2026-09-11, verified against live rows):
--   * claim_withdrawal_verified reserved float BEFORE checking who owned the
--     row, then on "0 rows updated" called release_merchant_float(withdrawal,
--     'claim_race_lost'). When the SAME merchant retried a claim that had
--     already committed (lost HTTP response, double tap), the retry released
--     that merchant's own live reservation and told them "Already claimed by
--     another agent". All 23 claim_race_lost rows in the 24h before this
--     migration were self-retries after a successful claim; none was a real
--     two-merchant race. (Brian Kagumba: reservation created 20:12:06 UTC,
--     customer "being processed" SMS 20:12:07, released by his own retry
--     20:12:29.)
--   * accept_withdrawal_dispatch (dispatch pop-up) assigned withdrawals with
--     NO float reservation at all -- a second, independent claim path.
--
-- This migration makes claim_withdrawal_verified the ONE claim transaction:
--   lock merchant -> lock withdrawal row -> classify (mine / other / closed)
--   -> one-active-claim -> permissions -> priority -> payout-detail check
--   -> [savepoint: reserve float + assign + invariant check] -> audit
--   -> return the full claimed withdrawal.
-- A same-merchant retry is idempotent success and never reserves or releases.
-- A losing merchant never touches the winner's reservation.
-- accept_withdrawal_dispatch now delegates to it (same signature and response
-- keys, so already-open pop-ups keep working).
--
-- Deliberately NOT touched (out of Prompt 1 scope): reserve_merchant_float,
-- release_merchant_float, release_stale_cashout_claims and its cron, payout
-- completion (approve-withdrawal), proof, commissions, manual release, RLS.
--
-- Data safety: creates one table and five functions, replaces two functions.
-- No existing withdrawal, reservation, wallet or ledger row is modified.
-- Rollback: re-run the previous definitions of claim_withdrawal_verified and
-- accept_withdrawal_dispatch (captured verbatim in the PR); the new table and
-- helper functions can stay (nothing else depends on them).


-- ── 1. Structured claim-attempt telemetry ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.withdrawal_claim_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid,
  agent_user_id uuid,
  desk_id uuid,
  result_code text NOT NULL,
  error_code text,
  idempotent boolean NOT NULL DEFAULT false,
  race_lost boolean NOT NULL DEFAULT false,
  blocking_withdrawal_id uuid,
  reservation_outcome text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_withdrawal_claim_attempts_withdrawal
  ON public.withdrawal_claim_attempts (withdrawal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawal_claim_attempts_agent
  ON public.withdrawal_claim_attempts (agent_user_id, created_at DESC);

ALTER TABLE public.withdrawal_claim_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff and the merchant read claim attempts" ON public.withdrawal_claim_attempts;
CREATE POLICY "Staff and the merchant read claim attempts"
  ON public.withdrawal_claim_attempts FOR SELECT TO authenticated
  USING (public.is_withdrawal_staff(auth.uid()) OR agent_user_id = auth.uid());
-- No INSERT/UPDATE/DELETE policy and no write grant: rows are written only by
-- the SECURITY DEFINER claim functions below.
REVOKE ALL ON public.withdrawal_claim_attempts FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.withdrawal_claim_attempts FROM authenticated;
GRANT SELECT ON public.withdrawal_claim_attempts TO authenticated;


-- ── 2. Internal helpers (not callable by clients) ──────────────────────────
CREATE OR REPLACE FUNCTION public.merchant_claim_log(
  p_withdrawal_id uuid, p_agent_user_id uuid, p_desk_id uuid, p_result_code text,
  p_error_code text DEFAULT NULL, p_idempotent boolean DEFAULT false,
  p_race_lost boolean DEFAULT false, p_blocking_withdrawal_id uuid DEFAULT NULL,
  p_reservation_outcome text DEFAULT NULL, p_detail text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.withdrawal_claim_attempts (
    withdrawal_id, agent_user_id, desk_id, result_code, error_code, idempotent,
    race_lost, blocking_withdrawal_id, reservation_outcome, detail)
  VALUES (
    p_withdrawal_id, p_agent_user_id, p_desk_id, p_result_code, p_error_code, p_idempotent,
    p_race_lost, p_blocking_withdrawal_id, p_reservation_outcome, left(p_detail, 500));
EXCEPTION WHEN OTHERS THEN
  -- Telemetry must never decide a claim.
  RAISE WARNING 'withdrawal_claim_attempts insert failed: %', SQLERRM;
END;
$function$;

CREATE OR REPLACE FUNCTION public.merchant_claim_fail(
  p_withdrawal_id uuid, p_agent_user_id uuid, p_desk_id uuid, p_result_code text,
  p_error text, p_message text, p_blocking_withdrawal_id uuid DEFAULT NULL,
  p_race_lost boolean DEFAULT false, p_detail text DEFAULT NULL,
  p_reservation_outcome text DEFAULT 'none')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.merchant_claim_log(p_withdrawal_id, p_agent_user_id, p_desk_id, p_result_code,
    p_error, false, p_race_lost, p_blocking_withdrawal_id, p_reservation_outcome, p_detail);
  RETURN jsonb_build_object(
    'success', false,
    'idempotent', false,
    'error', p_error,
    'result_code', p_result_code,
    'message', p_message,
    'blocking_withdrawal_id', p_blocking_withdrawal_id,
    'withdrawal_id', p_withdrawal_id,
    'detail', p_detail);
END;
$function$;

-- The claimed withdrawal exactly as "Claimed by you" renders it: the full row,
-- `profiles` / `linked_party_profile` in the shape attachProfiles() produces,
-- and the float reservation. Only ever returned to the desk that holds the
-- claim (the row-level policy already lets that desk read the same row).
CREATE OR REPLACE FUNCTION public.merchant_claim_payload(p_withdrawal_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'claim', to_jsonb(w) || jsonb_build_object(
      'claimed_at', w.dispatched_at,
      'profiles', CASE WHEN p.id IS NULL THEN NULL
        ELSE jsonb_build_object('id', p.id, 'full_name', p.full_name, 'phone', p.phone) END,
      'linked_party_profile', CASE WHEN lp.id IS NULL THEN NULL
        ELSE jsonb_build_object('id', lp.id, 'full_name', lp.full_name, 'phone', lp.phone) END),
    'reservation', CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', r.id, 'state', r.state, 'agent_id', r.agent_id, 'desk_id', r.desk_id,
      'amount_requested', r.amount_requested, 'telecom_expected', r.telecom_expected,
      'reserved_amount', r.reserved_amount, 'planned_out_of_pocket', r.planned_out_of_pocket,
      'available_before', r.available_before, 'reserved_at', r.reserved_at) END)
  FROM public.withdrawal_requests w
  LEFT JOIN public.profiles p ON p.id = w.user_id
  LEFT JOIN public.profiles lp ON lp.id = w.linked_party
  LEFT JOIN public.merchant_float_reservations r ON r.withdrawal_id = w.id
  WHERE w.id = p_withdrawal_id;
$function$;


-- ── 3. The canonical claim transaction ─────────────────────────────────────
-- Signature unchanged so every existing caller keeps working. Response keys
-- kept for old clients: `success`, `error`, `message`, `withdrawal_id`,
-- `blocking_withdrawal_id`, `reserved_amount`, `planned_out_of_pocket`.
CREATE OR REPLACE FUNCTION public.claim_withdrawal_verified(p_withdrawal_id uuid, p_momo_number text DEFAULT NULL::text, p_momo_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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


-- ── 4. Read-only claim status for ambiguous network outcomes ───────────────
-- "Did my claim commit?" without guessing from a table read that RLS may hide.
-- Never reveals WHICH other merchant holds a row.
CREATE OR REPLACE FUNCTION public.get_withdrawal_claim_status(p_withdrawal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_desk uuid;
  v_w record;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('state', 'unknown', 'error', 'not_authenticated');
  END IF;

  SELECT id INTO v_desk FROM public.cashout_agents
  WHERE agent_id = v_uid AND is_active = true
  ORDER BY created_at, id LIMIT 1;
  IF v_desk IS NULL THEN
    RETURN jsonb_build_object('state', 'unknown', 'error', 'not_cashout_agent');
  END IF;

  SELECT id, status, assigned_cashout_agent_id, processed_at, fin_ops_reference, hidden_from_merchant_queue
    INTO v_w
  FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'not_found', 'withdrawal_id', p_withdrawal_id);
  END IF;

  IF v_w.assigned_cashout_agent_id = v_desk THEN
    IF v_w.status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved', 'approved')
       AND v_w.processed_at IS NULL AND COALESCE(v_w.fin_ops_reference, '') = '' THEN
      RETURN jsonb_build_object('state', 'mine', 'withdrawal_id', p_withdrawal_id)
        || public.merchant_claim_payload(p_withdrawal_id);
    END IF;
    RETURN jsonb_build_object('state', 'mine_closed', 'withdrawal_id', p_withdrawal_id, 'status', v_w.status);
  END IF;

  IF v_w.assigned_cashout_agent_id IS NOT NULL THEN
    RETURN jsonb_build_object('state', 'other', 'withdrawal_id', p_withdrawal_id);
  END IF;

  IF v_w.status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved')
     AND v_w.processed_at IS NULL AND COALESCE(v_w.fin_ops_reference, '') = ''
     AND v_w.hidden_from_merchant_queue IS NOT TRUE THEN
    RETURN jsonb_build_object('state', 'unassigned', 'withdrawal_id', p_withdrawal_id);
  END IF;

  RETURN jsonb_build_object('state', 'not_actionable', 'withdrawal_id', p_withdrawal_id, 'status', v_w.status);
END;
$function$;


-- ── 5. Dispatch pop-up: same transaction, same response keys ───────────────
-- Previously assigned the row with no float reservation (an independent claim
-- implementation). Now a thin wrapper: keeps its channel check and its
-- `ok` / `error` keys for already-open clients, and claims through
-- claim_withdrawal_verified using the row's stored payout details (exactly
-- what the queue's Claim button sends).
CREATE OR REPLACE FUNCTION public.accept_withdrawal_dispatch(p_withdrawal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_w record;
  v_result jsonb;
  v_ok boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cashout_agents WHERE agent_id = v_uid AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'error', 'not_merchant_agent');
  END IF;

  SELECT payout_method, mobile_money_provider, bank_name, mobile_money_number, mobile_money_name
    INTO v_w
  FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'error', 'not_found');
  END IF;

  IF NOT public.merchant_handles_payout(v_uid, v_w.payout_method, v_w.mobile_money_provider, v_w.bank_name) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'error', 'provider_not_assigned');
  END IF;

  v_result := public.claim_withdrawal_verified(p_withdrawal_id, v_w.mobile_money_number, v_w.mobile_money_name);
  v_ok := COALESCE((v_result->>'success')::boolean, false);

  IF v_ok THEN
    UPDATE public.withdrawal_notification_log
       SET response = 'accepted', claimed_at = now(), updated_at = now()
     WHERE withdrawal_id = p_withdrawal_id AND recipient_id = v_uid;
    UPDATE public.withdrawal_notification_log
       SET response = 'superseded', claimed_at = now(), updated_at = now()
     WHERE withdrawal_id = p_withdrawal_id AND recipient_id <> v_uid AND response = 'pending';
  END IF;

  RETURN v_result || jsonb_build_object('ok', v_ok);
END;
$function$;


-- ── 6. Privileges ──────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.merchant_claim_log(uuid, uuid, uuid, text, text, boolean, boolean, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merchant_claim_fail(uuid, uuid, uuid, text, text, text, uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merchant_claim_payload(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_withdrawal_claim_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_withdrawal_claim_status(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.claim_withdrawal_verified(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_withdrawal_verified(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.accept_withdrawal_dispatch(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_withdrawal_dispatch(uuid) TO authenticated;
