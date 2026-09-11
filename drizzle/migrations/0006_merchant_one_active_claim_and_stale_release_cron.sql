-- lovable-cron-fallback-reviewed: 288 runs/day; stale merchant payout claims must return to the shared queue shortly after the existing 45-minute zero-progress window, and there is no row-change event that fires when a claim simply goes quiet
-- 1) Enforce ONE ACTIVE CLAIM PER MERCHANT atomically inside the claim RPC.
--    Race safety: a transaction-scoped advisory lock keyed on the merchant's
--    cashout_agents.id serialises concurrent claim attempts by the SAME merchant,
--    so two simultaneous claims can never both pass the "no other active claim"
--    check. Different merchants are unaffected (different lock key), and the
--    existing one-withdrawal-to-one-merchant guard
--    (UPDATE ... WHERE assigned_cashout_agent_id IS NULL) is preserved verbatim.
--    The gate runs BEFORE reserve_merchant_float so a refused claim never leaves
--    a dangling float reservation.
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

-- 2) Real server-side cron for the existing guarded stale-claim releaser.
--    Idempotent: unschedules any prior registration before (re)scheduling.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'release-stale-cashout-claims') THEN
      PERFORM cron.unschedule('release-stale-cashout-claims');
    END IF;
    PERFORM cron.schedule(
      'release-stale-cashout-claims',
      '*/5 * * * *',
      $job$ SELECT public.release_stale_cashout_claims(); $job$
    );
  END IF;
END
$cron$;