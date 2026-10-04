-- Reversal-scoped available balance: the platform-wide "advance withdrawals
-- paused" treasury control locks advance-funded withdrawable money so agents
-- cannot cash it out. That lock must NOT block the company from clawing that
-- exact money back when the advance itself is being reversed. This function is
-- the ONLY place that intentionally ignores the advance lock; it still respects
-- the projection (ledger-backed) withdrawable and pending holds, so a wallet can
-- never be driven negative.
CREATE OR REPLACE FUNCTION public.get_user_advance_reversal_available(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
    0::numeric,
    COALESCE((
      SELECT withdrawable FROM public.wallet_balances_projection WHERE user_id = p_user_id
    ), 0::numeric)
    - public.funder_pending_hold(p_user_id)
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_user_advance_reversal_available(uuid) TO authenticated, service_role;

-- advance_reversal_plan: price the clawback against the reversal-scoped balance.
CREATE OR REPLACE FUNCTION public.advance_reversal_plan(p_advance_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_adv RECORD;
  v_req RECORD;
  v_disbursed boolean := false;
  v_disbursed_amount numeric := 0;
  v_clawed numeric := 0;
  v_withdrawable numeric := 0;
  v_approved_at timestamptz;
  v_tag text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.has_role(v_caller, 'cfo'::app_role) OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can reverse an advance';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance not found';
  END IF;

  v_tag := 'advance_reversal:' || p_advance_id::text;

  IF v_adv.request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM public.agent_advance_requests WHERE id = v_adv.request_id;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_disbursed_amount
  FROM public.general_ledger
  WHERE source_table = 'agent_advance_requests'
    AND source_id = v_adv.request_id
    AND category = 'agent_advance_credit'
    AND ledger_scope = 'wallet';
  v_disbursed := v_disbursed_amount > 0;

  SELECT COALESCE(SUM(amount), 0) INTO v_clawed
  FROM public.cfo_debit_obligations
  WHERE user_id = v_adv.agent_id
    AND metadata->>'sub_category' = v_tag;

  BEGIN
    v_withdrawable := COALESCE(public.get_user_advance_reversal_available(v_adv.agent_id), 0);
  EXCEPTION WHEN OTHERS THEN
    v_withdrawable := 0;
  END;

  v_approved_at := COALESCE(v_req.cfo_paid_at, v_req.cfo_approved_at, v_adv.issued_at);

  RETURN jsonb_build_object(
    'advance_id', p_advance_id,
    'agent_id', v_adv.agent_id,
    'request_id', v_adv.request_id,
    'status', v_adv.status,
    'principal', COALESCE(v_adv.principal, 0),
    'outstanding_balance', COALESCE(v_adv.outstanding_balance, 0),
    'already_reversed', v_adv.reversed_at IS NOT NULL,
    'approved_at', v_approved_at,
    'approved_today', (v_approved_at AT TIME ZONE 'Africa/Kampala')::date
                      = (now() AT TIME ZONE 'Africa/Kampala')::date,
    'disbursed', v_disbursed,
    'disbursed_amount', v_disbursed_amount,
    'clawback_posted', v_clawed > 0,
    'clawback_posted_amount', v_clawed,
    'withdrawable', v_withdrawable,
    'recommended_clawback', GREATEST(0, LEAST(v_disbursed_amount - v_clawed, v_withdrawable)),
    'clawback_tag', v_tag,
    'request_status', v_req.status,
    'has_request', v_adv.request_id IS NOT NULL
  );
END;
$$;

-- advance_reversal_plan_batch: same reversal-scoped balance for the preview.
CREATE OR REPLACE FUNCTION public.advance_reversal_plan_batch(p_advance_ids uuid[] DEFAULT NULL::uuid[], p_today_only boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_rows jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.has_role(v_caller, 'cfo'::app_role) OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can reverse an advance';
  END IF;

  WITH base AS (
    SELECT a.id, a.agent_id, a.request_id, a.status, a.principal,
           a.outstanding_balance, a.reversed_at, a.issued_at
    FROM public.agent_advances a
    WHERE (p_advance_ids IS NULL OR a.id = ANY(p_advance_ids))
      AND (
        p_advance_ids IS NOT NULL
        OR (
          a.reversed_at IS NULL
          AND (a.issued_at AT TIME ZONE 'Africa/Kampala')::date
              = (now() AT TIME ZONE 'Africa/Kampala')::date
        )
      )
  ), enriched AS (
    SELECT
      b.*,
      r.status AS request_status,
      r.reviewed_by_agent_ops,
      COALESCE(r.cfo_paid_at, r.cfo_approved_at, b.issued_at) AS approved_at,
      p.full_name AS agent_name,
      p.phone AS agent_phone,
      COALESCE(d.disbursed_amount, 0) AS disbursed_amount,
      COALESCE(c.clawed, 0) AS clawback_posted_amount,
      COALESCE(public.get_user_advance_reversal_available(b.agent_id), 0) AS withdrawable
    FROM base b
    LEFT JOIN public.agent_advance_requests r ON r.id = b.request_id
    LEFT JOIN public.profiles p ON p.id = b.agent_id
    LEFT JOIN LATERAL (
      SELECT SUM(gl.amount) AS disbursed_amount
      FROM public.general_ledger gl
      WHERE gl.source_table = 'agent_advance_requests'
        AND gl.source_id = b.request_id
        AND gl.category = 'agent_advance_credit'
        AND gl.ledger_scope = 'wallet'
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT SUM(o.amount) AS clawed
      FROM public.cfo_debit_obligations o
      WHERE o.user_id = b.agent_id
        AND o.metadata->>'sub_category' = 'advance_reversal:' || b.id::text
    ) c ON true
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'agent_name' NULLS LAST), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'advance_id', e.id,
      'agent_id', e.agent_id,
      'agent_name', e.agent_name,
      'agent_phone', e.agent_phone,
      'request_id', e.request_id,
      'has_request', e.request_id IS NOT NULL,
      'status', e.status,
      'request_status', e.request_status,
      'principal', COALESCE(e.principal, 0),
      'outstanding_balance', COALESCE(e.outstanding_balance, 0),
      'already_reversed', e.reversed_at IS NOT NULL,
      'approved_at', e.approved_at,
      'approved_today', (e.approved_at AT TIME ZONE 'Africa/Kampala')::date
                        = (now() AT TIME ZONE 'Africa/Kampala')::date,
      'disbursed', e.disbursed_amount > 0,
      'disbursed_amount', e.disbursed_amount,
      'clawback_posted_amount', e.clawback_posted_amount,
      'amount_to_reverse', GREATEST(0, e.disbursed_amount - e.clawback_posted_amount),
      'withdrawable', e.withdrawable,
      'recoverable_now', GREATEST(0, LEAST(e.disbursed_amount - e.clawback_posted_amount, e.withdrawable)),
      'shortfall', GREATEST(0,
        GREATEST(0, e.disbursed_amount - e.clawback_posted_amount)
        - GREATEST(0, LEAST(e.disbursed_amount - e.clawback_posted_amount, e.withdrawable))),
      'clawback_tag', 'advance_reversal:' || e.id::text
    ) AS x
    FROM enriched e
    WHERE p_today_only = false
       OR p_advance_ids IS NOT NULL
       OR (e.approved_at AT TIME ZONE 'Africa/Kampala')::date
          = (now() AT TIME ZONE 'Africa/Kampala')::date
  ) s;

  RETURN jsonb_build_object('rows', v_rows, 'count', jsonb_array_length(v_rows));
END;
$$;