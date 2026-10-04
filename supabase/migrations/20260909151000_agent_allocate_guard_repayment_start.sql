-- Bug 2: nothing stopped a collection before repayment had started.
--
-- The rule is that a Rent Plan funded today starts repaying tomorrow, and the
-- data already reflects it: `repayment_starts_on` is populated on all 1,318
-- funded/repaying/completed plans, 1,197 of them at funded + 1.
--
-- But it was never enforced. `agent_allocate_tenant_payment` — the only RPC
-- that writes a collection — did not reference `repayment_starts_on`,
-- `term_start` or `funded_at` at all. Neither does `agent_expected_collection`
-- or `enforce_agent_daily_eligibility`. Measured 2026-09-09: 29 collections
-- across 24 plans, 1,098,567, had already been taken before the plan's
-- repayment start date, the earliest on 2026-05-26.
--
-- Those collections are structurally unscoreable — they land on a day the plan
-- was not billed, so they can only ever be counted as arrears.
--
-- Fix: reject the allocation before any money moves, returning the same
-- structured shape as the existing NOT_YOUR_TENANT branch so the app can render
-- a countdown rather than a raw error. Server-side because the frontend is not
-- the only caller and there is no other control.
--
-- `repayment_starts_on` is read with the same COALESCE fallback as
-- `v_rent_plan_schedule.term_start`, so the guard and the schedule agree on the
-- start date by construction.
--
-- Everything else is byte-identical to the previous definition: same signature,
-- plpgsql, SECURITY DEFINER, search_path, auth and ownership checks, the
-- tracking-only partial semantics, and the additive stamping of
-- expected/shortfall/is_partial onto the recorded collection.

CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text, p_partial_confirmed boolean DEFAULT false, p_partial_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_assigned uuid;
  v_expected numeric;
  v_shortfall numeric;
  v_is_partial boolean := false;
  v_reason text := NULLIF(btrim(COALESCE(p_partial_reason, '')), '');
  v_result jsonb;
  v_collection_id uuid;
  v_starts_on date;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_agent_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Agents may allocate payments only from their own wallet'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'agent'::public.app_role)
    OR public.has_role(v_uid, 'senior_agent'::public.app_role)
    OR public.has_role(v_uid, 'sub_agent'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Agent role required' USING ERRCODE = '42501';
  END IF;

  SELECT rr.agent_id, rr.assigned_agent_id
    INTO v_owner, v_assigned
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id
     AND rr.tenant_id = p_tenant_id;

  IF v_owner IS NULL AND v_assigned IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  IF v_uid IS DISTINCT FROM v_owner
     AND v_uid IS DISTINCT FROM v_assigned
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_subagents sa
        WHERE sa.parent_agent_id = v_uid
          AND sa.sub_agent_id IN (v_owner, v_assigned)
          AND sa.status IN ('verified','approved','accepted')
     ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'NOT_YOUR_TENANT',
      'error', 'This tenant is no longer assigned to you. Refresh your list.'
    );
  END IF;

  -- Repayment starts the day AFTER funding. Enforce it here: this is the only
  -- RPC that writes a collection, and nothing else checks the start date.
  SELECT COALESCE(
           rr.repayment_starts_on,
           (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala')::date
         )
    INTO v_starts_on
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id;

  IF v_starts_on IS NOT NULL AND v_today < v_starts_on THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'REPAYMENT_NOT_STARTED',
      'error', format(
        'Repayment for this Rent Plan starts on %s. Collection opens then.',
        to_char(v_starts_on, 'DD Mon YYYY')
      ),
      'repayment_starts_on', v_starts_on,
      'days_until_start', (v_starts_on - v_today)
    );
  END IF;

  -- Expected collection for this tenant: today's pinned instalment, capped at
  -- the balance. Tracking only — partial collections are recorded, never blocked.
  v_expected := COALESCE(public.agent_expected_collection(p_rent_request_id), 0);
  v_shortfall := GREATEST(0, v_expected - COALESCE(p_amount, 0));
  v_is_partial := v_expected > 0 AND COALESCE(p_amount, 0) < v_expected;

  v_result := public.agent_allocate_tenant_payment_internal(
    p_agent_id,
    p_tenant_id,
    p_rent_request_id,
    p_amount,
    p_notes
  );

  -- Stamp expectation vs reality on the recorded collection (additive only)
  IF COALESCE((v_result->>'success')::boolean, false) THEN
    v_collection_id := NULLIF(v_result->>'collection_id', '')::uuid;
    IF v_collection_id IS NOT NULL THEN
      UPDATE public.agent_collections
         SET expected_amount = v_expected,
             shortfall_amount = v_shortfall,
             is_partial = v_is_partial,
             partial_reason = CASE WHEN v_is_partial THEN v_reason ELSE partial_reason END
       WHERE id = v_collection_id;
    END IF;

    v_result := v_result
      || jsonb_build_object(
           'expected_amount', v_expected,
           'shortfall_amount', v_shortfall,
           'is_partial', v_is_partial,
           'partial_reason', CASE WHEN v_is_partial THEN v_reason ELSE NULL END
         );
  END IF;

  RETURN v_result;
END;
$function$;
