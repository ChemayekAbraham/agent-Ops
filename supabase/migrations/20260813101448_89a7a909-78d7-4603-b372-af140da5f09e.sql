-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1: merchant float reservations — never hold more than the agent holds
-- ─────────────────────────────────────────────────────────────────────────────

-- Reserved float now ignores reservations that can no longer be legitimately
-- held: the payout already reached a terminal state, or the reservation has
-- been sitting open for more than 48h (stale claim / abandoned session).
CREATE OR REPLACE FUNCTION public.merchant_reserved_float(p_agent_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(GREATEST(r.reserved_amount, 0)), 0)
  FROM public.merchant_float_reservations r
  LEFT JOIN public.withdrawal_requests w ON w.id = r.withdrawal_id
  WHERE r.agent_id = p_agent_id
    AND r.state = 'reserved'
    AND COALESCE(r.reserved_at, r.created_at) > now() - interval '48 hours'
    AND COALESCE(w.status, 'pending') NOT IN (
      'completed', 'rejected', 'cancelled', 'failed', 'settled', 'paid'
    );
$function$;

-- Releases reservations that no longer deserve to hold float.
CREATE OR REPLACE FUNCTION public.release_stale_merchant_float_reservations()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal integer := 0;
  v_stale integer := 0;
BEGIN
  WITH t AS (
    UPDATE public.merchant_float_reservations r
       SET state = 'released',
           released_reason = 'withdrawal reached terminal state',
           settled_at = now()
     WHERE r.state = 'reserved'
       AND EXISTS (
         SELECT 1 FROM public.withdrawal_requests w
          WHERE w.id = r.withdrawal_id
            AND w.status IN ('completed','rejected','cancelled','failed','settled','paid')
       )
    RETURNING 1
  ) SELECT count(*) INTO v_terminal FROM t;

  WITH s AS (
    UPDATE public.merchant_float_reservations r
       SET state = 'released',
           released_reason = 'reservation expired (open more than 48h)',
           settled_at = now()
     WHERE r.state = 'reserved'
       AND COALESCE(r.reserved_at, r.created_at) <= now() - interval '48 hours'
    RETURNING 1
  ) SELECT count(*) INTO v_stale FROM s;

  RETURN jsonb_build_object(
    'released_terminal', v_terminal,
    'released_stale', v_stale,
    'ran_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.release_stale_merchant_float_reservations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_stale_merchant_float_reservations() TO service_role;

-- Recomputes reserved_amount first-come-first-served so the sum of open
-- reservations can never exceed the float the agent actually holds. Bulk-created
-- rows (which were all written with reserved_before = 0) get corrected here.
CREATE OR REPLACE FUNCTION public.repair_merchant_float_reservations(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rec record;
  v_agent uuid;
  v_float numeric;
  v_running numeric;
  v_need numeric;
  v_reserve numeric;
  v_fixed integer := 0;
  v_agents integer := 0;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cfo')
          OR public.has_role(auth.uid(), 'financial_ops')
          OR public.has_role(auth.uid(), 'manager')
          OR public.has_role(auth.uid(), 'super_admin')
          OR auth.uid() IS NULL) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  FOR v_agent IN
    SELECT DISTINCT agent_id FROM public.merchant_float_reservations
     WHERE state = 'reserved' AND (p_agent_id IS NULL OR agent_id = p_agent_id)
  LOOP
    v_agents := v_agents + 1;
    SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_float
      FROM public.wallets WHERE user_id = v_agent;
    v_float := COALESCE(v_float, 0);
    v_running := 0;

    FOR v_rec IN
      SELECT r.id, r.amount_requested, r.telecom_expected, r.reserved_amount
        FROM public.merchant_float_reservations r
       WHERE r.agent_id = v_agent AND r.state = 'reserved'
       ORDER BY COALESCE(r.reserved_at, r.created_at), r.id
    LOOP
      v_need := COALESCE(v_rec.amount_requested, 0) + COALESCE(v_rec.telecom_expected, 0);
      v_reserve := LEAST(GREATEST(v_float - v_running, 0), v_need);

      UPDATE public.merchant_float_reservations
         SET float_before = v_float,
             reserved_before = v_running,
             available_before = GREATEST(v_float - v_running, 0),
             reserved_amount = v_reserve,
             planned_out_of_pocket = GREATEST(v_need - v_reserve, 0)
       WHERE id = v_rec.id;

      IF COALESCE(v_rec.reserved_amount, 0) <> v_reserve THEN
        v_fixed := v_fixed + 1;
      END IF;
      v_running := v_running + v_reserve;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('agents_processed', v_agents, 'reservations_corrected', v_fixed);
END;
$function$;

REVOKE ALL ON FUNCTION public.repair_merchant_float_reservations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.repair_merchant_float_reservations(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2: out-of-pocket records require evidence before becoming a debt
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.merchant_out_of_pocket_advances
  DROP CONSTRAINT IF EXISTS merchant_oop_status_check;

ALTER TABLE public.merchant_out_of_pocket_advances
  ADD CONSTRAINT merchant_oop_status_check CHECK (
    status = ANY (ARRAY[
      'needs_review',
      'pending_reimbursement',
      'reimbursed',
      'written_off',
      'rejected'
    ])
  );

ALTER TABLE public.merchant_out_of_pocket_advances
  ADD COLUMN IF NOT EXISTS attested_at timestamptz,
  ADD COLUMN IF NOT EXISTS attested_by uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_merchant_oop_status_agent
  ON public.merchant_out_of_pocket_advances (status, agent_id, created_at DESC);

-- Merchant confirms they truly used their own money; Finance/CFO/admins can
-- confirm or reject any record. Confirmation is what turns a flagged shortfall
-- into money the company owes.
CREATE OR REPLACE FUNCTION public.review_merchant_out_of_pocket(
  p_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.merchant_out_of_pocket_advances;
  v_is_staff boolean;
  v_is_owner boolean;
  v_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_decision NOT IN ('confirm', 'reject') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;

  SELECT * INTO v_row FROM public.merchant_out_of_pocket_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_not_found';
  END IF;

  v_is_staff := public.has_role(auth.uid(), 'cfo')
             OR public.has_role(auth.uid(), 'financial_ops')
             OR public.has_role(auth.uid(), 'manager')
             OR public.has_role(auth.uid(), 'super_admin');
  v_is_owner := v_row.agent_id = auth.uid();

  IF NOT (v_is_staff OR v_is_owner) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF v_row.status NOT IN ('needs_review', 'pending_reimbursement') THEN
    RAISE EXCEPTION 'record_already_settled';
  END IF;

  IF p_decision = 'reject' THEN
    IF NOT v_is_staff THEN
      RAISE EXCEPTION 'not_authorized';
    END IF;
    IF p_note IS NULL OR length(btrim(p_note)) < 10 THEN
      RAISE EXCEPTION 'reason_required_min_10_chars';
    END IF;
    v_status := 'rejected';
  ELSE
    -- A merchant confirming moves it to money owed. Staff confirming does the same.
    v_status := 'pending_reimbursement';
  END IF;

  UPDATE public.merchant_out_of_pocket_advances
     SET status = v_status,
         attested_at = CASE WHEN v_is_owner AND p_decision = 'confirm' THEN now() ELSE attested_at END,
         attested_by = CASE WHEN v_is_owner AND p_decision = 'confirm' THEN auth.uid() ELSE attested_by END,
         reviewed_at = CASE WHEN v_is_staff THEN now() ELSE reviewed_at END,
         reviewed_by = CASE WHEN v_is_staff THEN auth.uid() ELSE reviewed_by END,
         review_note = COALESCE(NULLIF(btrim(p_note), ''), review_note)
   WHERE id = p_id;

  INSERT INTO public.system_events (event_type, user_id, description, metadata)
  VALUES (
    'wallet_transfer',
    v_row.agent_id,
    format('Merchant own-money record %s by %s (UGX %s).',
           CASE WHEN p_decision = 'confirm' THEN 'confirmed' ELSE 'rejected' END,
           CASE WHEN v_is_staff THEN 'finance' ELSE 'the merchant' END,
           to_char(COALESCE(v_row.shortfall_amount, 0), 'FM999,999,999')),
    jsonb_build_object(
      'record_id', p_id,
      'withdrawal_id', v_row.withdrawal_id,
      'decision', p_decision,
      'new_status', v_status,
      'actor', auth.uid(),
      'note', p_note
    )
  );

  RETURN jsonb_build_object('success', true, 'id', p_id, 'status', v_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.review_merchant_out_of_pocket(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_merchant_out_of_pocket(uuid, text, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 3: dashboard reads split "confirmed owed" from "awaiting review"
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_merchant_out_of_pocket_summary(p_agent_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_owed numeric := 0;
  v_review numeric := 0;
  v_rejected numeric := 0;
  v_reimbursed numeric := 0;
  v_tel_today numeric := 0;
  v_tel_month numeric := 0;
  v_tel_total numeric := 0;
  v_count integer := 0;
  v_review_count integer := 0;
BEGIN
  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('owed_to_agent', 0, 'under_review', 0, 'rejected_total', 0,
      'reimbursed_total', 0, 'telecom_today', 0, 'telecom_month', 0, 'telecom_total', 0,
      'pending_count', 0, 'under_review_count', 0);
  END IF;

  IF v_agent <> auth.uid()
     AND NOT (public.has_role(auth.uid(), 'cfo')
              OR public.has_role(auth.uid(), 'financial_ops')
              OR public.has_role(auth.uid(), 'super_admin')
              OR public.is_ops_role(auth.uid())) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN status = 'pending_reimbursement' THEN shortfall_amount ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN status = 'needs_review' THEN shortfall_amount ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN status = 'rejected' THEN shortfall_amount ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN status = 'reimbursed' THEN shortfall_amount ELSE 0 END), 0),
         COUNT(*) FILTER (WHERE status = 'pending_reimbursement'),
         COUNT(*) FILTER (WHERE status = 'needs_review')
    INTO v_owed, v_review, v_rejected, v_reimbursed, v_count, v_review_count
    FROM public.merchant_out_of_pocket_advances
   WHERE agent_id = v_agent;

  SELECT COALESCE(SUM(gl.amount), 0)
    INTO v_tel_total
    FROM public.general_ledger gl
   WHERE gl.user_id = v_agent
     AND gl.ledger_scope = 'wallet'
     AND gl.reference_id LIKE '%-merchant-telecom-charge';

  SELECT COALESCE(SUM(gl.amount), 0)
    INTO v_tel_today
    FROM public.general_ledger gl
   WHERE gl.user_id = v_agent
     AND gl.ledger_scope = 'wallet'
     AND gl.reference_id LIKE '%-merchant-telecom-charge'
     AND (gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date = v_today;

  SELECT COALESCE(SUM(gl.amount), 0)
    INTO v_tel_month
    FROM public.general_ledger gl
   WHERE gl.user_id = v_agent
     AND gl.ledger_scope = 'wallet'
     AND gl.reference_id LIKE '%-merchant-telecom-charge'
     AND (gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date
         >= date_trunc('month', v_today)::date;

  RETURN jsonb_build_object(
    'owed_to_agent', v_owed,
    'under_review', v_review,
    'rejected_total', v_rejected,
    'reimbursed_total', v_reimbursed,
    'telecom_today', v_tel_today,
    'telecom_month', v_tel_month,
    'telecom_total', v_tel_total,
    'pending_count', v_count,
    'under_review_count', v_review_count
  );
END;
$function$;

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
  v_consumed_today numeric := 0;
  v_oop numeric := 0;
  v_oop_review numeric := 0;
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

  SELECT COALESCE(SUM(CASE WHEN status = 'pending_reimbursement' THEN shortfall_amount ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN status = 'needs_review' THEN shortfall_amount ELSE 0 END), 0)
    INTO v_oop, v_oop_review
  FROM public.merchant_out_of_pocket_advances
  WHERE agent_id = v_agent;

  SELECT COALESCE(NULLIF(value, '')::numeric, 500000) INTO v_headroom
  FROM public.treasury_controls WHERE control_key = 'merchant_out_of_pocket_headroom';

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'float_balance', COALESCE(v_float, 0),
    'reserved_float', v_reserved,
    'available_float', GREATEST(COALESCE(v_float, 0) - v_reserved, 0),
    'consumed_float_today', v_consumed_today,
    'out_of_pocket_outstanding', v_oop,
    'out_of_pocket_under_review', v_oop_review,
    'out_of_pocket_headroom', COALESCE(v_headroom, 500000),
    'computed_at', now()
  );
END;
$function$;
