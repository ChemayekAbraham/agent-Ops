-- ============================================================
-- PHASE 4: MERCHANT FLOAT RESERVATION / CONSUMPTION MODEL
-- ============================================================

-- Out-of-pocket headroom control (how far past held float a merchant may claim)
INSERT INTO public.treasury_controls (control_key, enabled, value)
SELECT 'merchant_out_of_pocket_headroom', true, '500000'
WHERE NOT EXISTS (
  SELECT 1 FROM public.treasury_controls WHERE control_key = 'merchant_out_of_pocket_headroom'
);

-- Telecom sending charge tiers, mirrored from src/lib/cashoutCharges.ts
CREATE OR REPLACE FUNCTION public.merchant_telecom_sending_charge(p_amount numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE
    WHEN COALESCE(p_amount, 0) <= 0 THEN 0
    WHEN p_amount <= 5000 THEN 100
    WHEN p_amount <= 60000 THEN 500
    WHEN p_amount <= 500000 THEN 1000
    WHEN p_amount <= 1000000 THEN 1500
    ELSE 2000
  END::numeric;
$fn$;

GRANT EXECUTE ON FUNCTION public.merchant_telecom_sending_charge(numeric) TO authenticated, service_role;

-- ── Reservation / consumption ledger ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.merchant_float_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL UNIQUE,
  agent_id uuid NOT NULL,
  desk_id uuid,
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'consumed', 'released')),
  amount_requested numeric NOT NULL DEFAULT 0,
  telecom_expected numeric NOT NULL DEFAULT 0,
  float_before numeric NOT NULL DEFAULT 0,
  reserved_before numeric NOT NULL DEFAULT 0,
  available_before numeric NOT NULL DEFAULT 0,
  reserved_amount numeric NOT NULL DEFAULT 0,
  planned_out_of_pocket numeric NOT NULL DEFAULT 0,
  consumed_float numeric NOT NULL DEFAULT 0,
  consumed_telecom numeric NOT NULL DEFAULT 0,
  out_of_pocket_amount numeric NOT NULL DEFAULT 0,
  float_after numeric,
  receivable_after numeric,
  released_reason text,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.merchant_float_reservations TO authenticated;
GRANT ALL ON public.merchant_float_reservations TO service_role;

ALTER TABLE public.merchant_float_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Merchants read own float reservations" ON public.merchant_float_reservations;
CREATE POLICY "Merchants read own float reservations"
ON public.merchant_float_reservations FOR SELECT TO authenticated
USING (
  agent_id = (SELECT auth.uid())
  OR public.has_role((SELECT auth.uid()), 'cfo')
  OR public.has_role((SELECT auth.uid()), 'financial_ops')
  OR public.has_role((SELECT auth.uid()), 'manager')
  OR public.has_role((SELECT auth.uid()), 'super_admin')
  OR public.has_role((SELECT auth.uid()), 'ceo')
  OR public.has_role((SELECT auth.uid()), 'coo')
);

CREATE INDEX IF NOT EXISTS idx_mfr_agent_state
  ON public.merchant_float_reservations (agent_id, state);

DROP TRIGGER IF EXISTS trg_mfr_touch ON public.merchant_float_reservations;
CREATE TRIGGER trg_mfr_touch
BEFORE UPDATE ON public.merchant_float_reservations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Open (still-reserved) float per agent ────────────────────────────
CREATE OR REPLACE FUNCTION public.merchant_reserved_float(p_agent_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(SUM(GREATEST(reserved_amount, 0)), 0)
  FROM public.merchant_float_reservations
  WHERE agent_id = p_agent_id AND state = 'reserved';
$fn$;

GRANT EXECUTE ON FUNCTION public.merchant_reserved_float(uuid) TO authenticated, service_role;

-- ── Authoritative per-agent float position ───────────────────────────
CREATE OR REPLACE FUNCTION public.get_merchant_float_position(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_float numeric := 0;
  v_reserved numeric := 0;
  v_consumed_today numeric := 0;
  v_oop numeric := 0;
  v_headroom numeric := 0;
BEGIN
  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('error', 'no_agent');
  END IF;
  IF v_agent <> auth.uid()
     AND NOT (public.has_role(auth.uid(), 'cfo')
       OR public.has_role(auth.uid(), 'financial_ops')
       OR public.has_role(auth.uid(), 'manager')
       OR public.has_role(auth.uid(), 'super_admin')
       OR public.has_role(auth.uid(), 'ceo')
       OR public.has_role(auth.uid(), 'coo')) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_float
  FROM public.wallets WHERE user_id = v_agent;

  v_reserved := public.merchant_reserved_float(v_agent);

  SELECT COALESCE(SUM(consumed_float + consumed_telecom), 0) INTO v_consumed_today
  FROM public.merchant_float_reservations
  WHERE agent_id = v_agent AND state = 'consumed'
    AND settled_at >= (now() AT TIME ZONE 'Africa/Kampala')::date;

  SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_oop
  FROM public.merchant_out_of_pocket_advances
  WHERE agent_id = v_agent AND status = 'pending_reimbursement';

  SELECT COALESCE(NULLIF(value, '')::numeric, 500000) INTO v_headroom
  FROM public.treasury_controls WHERE control_key = 'merchant_out_of_pocket_headroom';

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'float_balance', COALESCE(v_float, 0),
    'reserved_float', v_reserved,
    'available_float', GREATEST(COALESCE(v_float, 0) - v_reserved, 0),
    'consumed_float_today', v_consumed_today,
    'out_of_pocket_outstanding', v_oop,
    'out_of_pocket_headroom', COALESCE(v_headroom, 500000),
    'computed_at', now()
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_merchant_float_position(uuid) TO authenticated, service_role;

-- ── Reserve float at claim time (idempotent per withdrawal) ──────────
CREATE OR REPLACE FUNCTION public.reserve_merchant_float(
  p_withdrawal_id uuid,
  p_agent_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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

  SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_float
  FROM public.wallets WHERE user_id = v_agent FOR UPDATE;
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
$fn$;

GRANT EXECUTE ON FUNCTION public.reserve_merchant_float(uuid, uuid) TO authenticated, service_role;

-- ── Release a reservation (claim released / settlement failed) ───────
CREATE OR REPLACE FUNCTION public.release_merchant_float(
  p_withdrawal_id uuid,
  p_reason text DEFAULT 'claim_released'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_row public.merchant_float_reservations;
BEGIN
  SELECT * INTO v_row FROM public.merchant_float_reservations
  WHERE withdrawal_id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'noop', true);
  END IF;
  IF v_row.state = 'consumed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_consumed');
  END IF;
  UPDATE public.merchant_float_reservations
  SET state = 'released', reserved_amount = 0,
      released_reason = COALESCE(p_reason, 'claim_released'), settled_at = now()
  WHERE id = v_row.id;
  RETURN jsonb_build_object('success', true, 'released', true);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.release_merchant_float(uuid, text) TO authenticated, service_role;

-- ── Record actual consumption at settlement (idempotent) ─────────────
CREATE OR REPLACE FUNCTION public.consume_merchant_float(
  p_withdrawal_id uuid,
  p_agent_id uuid,
  p_consumed_float numeric,
  p_consumed_telecom numeric,
  p_out_of_pocket numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.merchant_float_reservations;
  v_float_after numeric := 0;
  v_receivable numeric := 0;
  v_amount numeric := 0;
  v_telecom numeric := 0;
BEGIN
  SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_float_after
  FROM public.wallets WHERE user_id = p_agent_id;

  SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_receivable
  FROM public.merchant_out_of_pocket_advances
  WHERE agent_id = p_agent_id AND status = 'pending_reimbursement';

  SELECT * INTO v_row FROM public.merchant_float_reservations
  WHERE withdrawal_id = p_withdrawal_id FOR UPDATE;

  IF FOUND AND v_row.state = 'consumed' THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true,
      'reservation_id', v_row.id);
  END IF;

  IF NOT FOUND THEN
    SELECT amount INTO v_amount FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
    v_telecom := public.merchant_telecom_sending_charge(COALESCE(v_amount, 0));
    INSERT INTO public.merchant_float_reservations (
      withdrawal_id, agent_id, desk_id, state, amount_requested, telecom_expected,
      float_before, reserved_before, available_before, reserved_amount,
      planned_out_of_pocket, consumed_float, consumed_telecom, out_of_pocket_amount,
      float_after, receivable_after, settled_at
    ) VALUES (
      p_withdrawal_id, p_agent_id,
      (SELECT id FROM public.cashout_agents WHERE agent_id = p_agent_id AND is_active IS TRUE LIMIT 1),
      'consumed', COALESCE(v_amount, 0), v_telecom,
      COALESCE(v_float_after, 0) + COALESCE(p_consumed_float, 0) + COALESCE(p_consumed_telecom, 0),
      0, 0, 0, COALESCE(p_out_of_pocket, 0),
      COALESCE(p_consumed_float, 0), COALESCE(p_consumed_telecom, 0),
      COALESCE(p_out_of_pocket, 0), v_float_after, v_receivable, now()
    );
    RETURN jsonb_build_object('success', true, 'backfilled', true,
      'float_after', v_float_after, 'receivable_after', v_receivable);
  END IF;

  UPDATE public.merchant_float_reservations SET
    state = 'consumed',
    reserved_amount = 0,
    consumed_float = COALESCE(p_consumed_float, 0),
    consumed_telecom = COALESCE(p_consumed_telecom, 0),
    out_of_pocket_amount = COALESCE(p_out_of_pocket, 0),
    float_after = v_float_after,
    receivable_after = v_receivable,
    settled_at = now()
  WHERE id = v_row.id;

  RETURN jsonb_build_object('success', true, 'reservation_id', v_row.id,
    'float_before', v_row.float_before, 'reserved_amount', v_row.reserved_amount,
    'consumed_float', COALESCE(p_consumed_float, 0),
    'consumed_telecom', COALESCE(p_consumed_telecom, 0),
    'out_of_pocket', COALESCE(p_out_of_pocket, 0),
    'float_after', v_float_after, 'receivable_after', v_receivable);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.consume_merchant_float(uuid, uuid, numeric, numeric, numeric) TO service_role;

-- ── Shared payout float: now subtracts EVERY claimed-but-unpaid payout ─
CREATE OR REPLACE FUNCTION public.get_merchant_payout_float()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_withdrawable numeric := 0;
  v_landlord_float numeric := 0;
  v_claimed numeric := 0;
  v_own jsonb;
BEGIN
  SELECT COALESCE(SUM(GREATEST(withdrawable_balance, 0)), 0) INTO v_withdrawable FROM public.wallets;
  SELECT COALESCE(SUM(GREATEST(balance, 0)), 0) INTO v_landlord_float FROM public.agent_landlord_float;

  -- FIX (Phase 4): claims are stamped by `claim_withdrawal_verified` WITHOUT a
  -- status change, so filtering on approved/processing missed most of them and
  -- overstated available float. Any non-terminal claimed payout is committed
  -- money.
  SELECT COALESCE(SUM(amount), 0) INTO v_claimed
  FROM public.withdrawal_requests
  WHERE status NOT IN ('completed', 'rejected', 'cancelled', 'failed', 'reversed')
    AND (assigned_cashout_agent_id IS NOT NULL OR dispatch_claimed_by IS NOT NULL);

  v_own := public.get_merchant_float_position(auth.uid());

  RETURN jsonb_build_object(
    'withdrawable_total', v_withdrawable,
    'landlord_float_total', v_landlord_float,
    'claimed_unsettled_total', v_claimed,
    'available_float', GREATEST(v_withdrawable + v_landlord_float - v_claimed, 0),
    'own_float_balance', COALESCE((v_own->>'float_balance')::numeric, 0),
    'own_reserved_float', COALESCE((v_own->>'reserved_float')::numeric, 0),
    'own_available_float', COALESCE((v_own->>'available_float')::numeric, 0),
    'own_consumed_today', COALESCE((v_own->>'consumed_float_today')::numeric, 0),
    'own_out_of_pocket_outstanding', COALESCE((v_own->>'out_of_pocket_outstanding')::numeric, 0),
    'computed_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_merchant_payout_float() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_merchant_payout_float() TO authenticated, service_role;

-- ── Claim-time reservation: no overcommitment ────────────────────────
CREATE OR REPLACE FUNCTION public.claim_withdrawal_verified(
  p_withdrawal_id uuid,
  p_momo_number text DEFAULT NULL::text,
  p_momo_name text DEFAULT NULL::text
)
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

-- ── Per-payout explainability ────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_merchant_payout_float_trace AS
SELECT
  r.withdrawal_id,
  r.agent_id,
  r.desk_id,
  p.full_name AS agent_name,
  w.status AS withdrawal_status,
  r.state AS float_state,
  r.amount_requested,
  r.telecom_expected,
  r.float_before,
  r.reserved_before,
  r.available_before,
  r.reserved_amount,
  r.planned_out_of_pocket,
  r.consumed_float,
  r.consumed_telecom,
  (r.consumed_float + r.consumed_telecom) AS consumed_total,
  r.out_of_pocket_amount AS fronted_personally,
  r.float_after,
  r.receivable_after,
  r.reserved_at,
  r.settled_at
FROM public.merchant_float_reservations r
LEFT JOIN public.withdrawal_requests w ON w.id = r.withdrawal_id
LEFT JOIN public.profiles p ON p.id = r.agent_id;

GRANT SELECT ON public.v_merchant_payout_float_trace TO authenticated, service_role;