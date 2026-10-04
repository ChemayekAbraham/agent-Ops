BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Auto-classify proxy-agent-initiated withdrawals as URGENT.
CREATE OR REPLACE FUNCTION public.set_proxy_withdrawal_urgent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.proxy_partner_id IS NOT NULL
     OR COALESCE(NEW.reason, '') LIKE '[Proxy initiated by agent%'
     OR (NEW.initiated_by IS NOT NULL
         AND NEW.agent_id IS NOT NULL
         AND NEW.initiated_by = NEW.agent_id
         AND NEW.agent_id <> NEW.user_id)
  THEN
    NEW.priority_level := 'urgent_proxy';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_set_proxy_withdrawal_urgent ON public.withdrawal_requests;
CREATE TRIGGER trg_set_proxy_withdrawal_urgent
BEFORE INSERT OR UPDATE OF proxy_partner_id, initiated_by, agent_id, reason, priority_level
ON public.withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.set_proxy_withdrawal_urgent();

-- 2. Backfill still-open proxy withdrawals.
UPDATE public.withdrawal_requests
   SET priority_level = 'urgent_proxy'
 WHERE COALESCE(priority_level, '') <> 'urgent_proxy'
   AND processed_at IS NULL
   AND fin_ops_reference IS NULL
   AND status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')
   AND (proxy_partner_id IS NOT NULL OR COALESCE(reason, '') LIKE '[Proxy initiated by agent%');

-- 3. Fast lookup of the blocking urgent proxy withdrawal.
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_urgent_proxy_open
  ON public.withdrawal_requests (created_at)
  WHERE priority_level = 'urgent_proxy'
    AND assigned_cashout_agent_id IS NULL
    AND processed_at IS NULL
    AND fin_ops_reference IS NULL;

-- 4. Read-only helper: the oldest urgent proxy withdrawal still awaiting a claim.
CREATE OR REPLACE FUNCTION public.blocking_urgent_proxy_withdrawal()
RETURNS TABLE (id uuid, amount numeric, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT w.id, w.amount, w.created_at
    FROM public.withdrawal_requests w
   WHERE w.priority_level = 'urgent_proxy'
     AND w.assigned_cashout_agent_id IS NULL
     AND w.processed_at IS NULL
     AND w.fin_ops_reference IS NULL
     AND w.status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')
   ORDER BY w.created_at ASC
   LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.blocking_urgent_proxy_withdrawal() TO authenticated;

-- 5. Atomic priority gate used by both claim entry points. Locks the urgent row
-- so concurrent claims serialize and a normal payout can never slip ahead.
CREATE OR REPLACE FUNCTION public.assert_no_urgent_proxy_priority(p_withdrawal_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_priority text;
  v_block uuid;
BEGIN
  SELECT priority_level INTO v_priority
    FROM public.withdrawal_requests WHERE id = p_withdrawal_id;

  -- The urgent proxy payout itself is always claimable.
  IF COALESCE(v_priority, '') = 'urgent_proxy' THEN
    RETURN NULL;
  END IF;

  SELECT w.id INTO v_block
    FROM public.withdrawal_requests w
   WHERE w.priority_level = 'urgent_proxy'
     AND w.assigned_cashout_agent_id IS NULL
     AND w.processed_at IS NULL
     AND w.fin_ops_reference IS NULL
     AND w.status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')
   ORDER BY w.created_at ASC
   LIMIT 1
   FOR UPDATE;

  RETURN v_block;
END;
$function$;

-- 6. Enforce the gate in claim_withdrawal_verified.
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
BEGIN
  SELECT id INTO v_agent_id
  FROM cashout_agents
  WHERE agent_id = auth.uid() AND is_active = true
  LIMIT 1;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_cashout_agent',
      'message', 'You are not an active cash-out agent.');
  END IF;

  SELECT * INTO v_w FROM withdrawal_requests WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found',
      'message', 'Withdrawal not found.');
  END IF;

  -- PRIORITY GATE: an unclaimed urgent proxy-agent withdrawal outranks every
  -- normal merchant payout. Row-locked, so simultaneous claims serialize.
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

  -- PHASE 4: reserve float BEFORE the claim is stamped. A claim can no longer
  -- overcommit the agent beyond held float + allowed out-of-pocket headroom.
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

-- 7. Enforce the same gate in the realtime dispatch accept path.
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

  v_block := public.assert_no_urgent_proxy_priority(p_withdrawal_id);
  IF v_block IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'proxy_priority_hold',
      'blocking_withdrawal_id', v_block,
      'message', 'A Priority Proxy Agent withdrawal must be processed first.');
  END IF;

  -- Channel + exact provider/bank assignment gate.
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

COMMIT;