CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text, p_partial_confirmed boolean DEFAULT false, p_partial_reason text DEFAULT NULL::text, p_client_ref uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid; v_assigned uuid;
  v_expected numeric; v_shortfall numeric;
  v_is_partial boolean := false;
  v_reason text := NULLIF(btrim(COALESCE(p_partial_reason, '')), '');
  v_result jsonb; v_collection_id uuid;
  v_starts_on date;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_prior record;
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

  IF p_client_ref IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent_collect:' || p_client_ref::text, 0));

    SELECT ac.id, ac.tracking_id, ac.amount, ac.created_at, ac.rent_request_id, ac.tenant_id
      INTO v_prior
      FROM public.agent_collections ac
     WHERE ac.client_ref = p_client_ref
     LIMIT 1;

    IF v_prior.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true, 'idempotent', true, 'client_ref', p_client_ref,
        'collection_id', v_prior.id, 'tracking_id', v_prior.tracking_id,
        'amount', v_prior.amount, 'amount_allocated', v_prior.amount,
        'processed_at', v_prior.created_at,
        'rent_request_id', v_prior.rent_request_id, 'tenant_id', v_prior.tenant_id,
        'note', 'Replay of an already-processed payment. No new collection, commission, rent allocation or fee allocation was created.');
    END IF;
  END IF;

  SELECT rr.agent_id, rr.assigned_agent_id INTO v_owner, v_assigned
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;

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
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_YOUR_TENANT',
      'error', 'This tenant is no longer assigned to you. Refresh your list.');
  END IF;

  -- Landlord-paid gate REMOVED (2026-09-21, business decision): tenant
  -- repayments are accepted even when the landlord float released to the agent
  -- has not yet reached the landlord. Landlord settlement is tracked separately
  -- via agent_landlord_float_allocations.

  SELECT COALESCE(rr.repayment_starts_on,
           (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala')::date)
    INTO v_starts_on
    FROM public.rent_requests rr WHERE rr.id = p_rent_request_id;

  IF v_starts_on IS NOT NULL AND v_today < v_starts_on THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'REPAYMENT_NOT_STARTED',
      'error', format('Repayment for this Rent Plan starts on %s. Collection opens then.',
                      to_char(v_starts_on, 'DD Mon YYYY')),
      'repayment_starts_on', v_starts_on,
      'days_until_start', (v_starts_on - v_today));
  END IF;

  v_expected := COALESCE(public.agent_expected_collection(p_rent_request_id), 0);
  v_shortfall := GREATEST(0, v_expected - COALESCE(p_amount, 0));
  v_is_partial := v_expected > 0 AND COALESCE(p_amount, 0) < v_expected;

  v_result := public.agent_allocate_tenant_payment_internal(
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount, p_notes, p_client_ref);

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

    BEGIN
      PERFORM public.rent_apply_collections_to_days(p_rent_request_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'rent day attribution failed for plan %: %', p_rent_request_id, SQLERRM;
    END;

    v_result := v_result || jsonb_build_object(
      'expected_amount', v_expected, 'shortfall_amount', v_shortfall,
      'is_partial', v_is_partial,
      'partial_reason', CASE WHEN v_is_partial THEN v_reason ELSE NULL END);
  END IF;

  RETURN v_result;
END;
$function$;