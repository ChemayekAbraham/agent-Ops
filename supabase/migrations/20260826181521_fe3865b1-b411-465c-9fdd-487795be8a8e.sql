-- 1. Additive tracking columns on agent_collections
ALTER TABLE public.agent_collections
  ADD COLUMN IF NOT EXISTS expected_amount numeric,
  ADD COLUMN IF NOT EXISTS shortfall_amount numeric,
  ADD COLUMN IF NOT EXISTS is_partial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS partial_reason text;

CREATE INDEX IF NOT EXISTS idx_agent_collections_partial
  ON public.agent_collections (is_partial, created_at DESC)
  WHERE is_partial = true;

-- 2. Single source of truth for "what should this collection be?"
CREATE OR REPLACE FUNCTION public.agent_expected_collection(p_rent_request_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
           0,
           LEAST(
             COALESCE(rr.daily_repayment, 0),
             GREATEST(0, COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0))
           )
         )
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id;
$$;

REVOKE ALL ON FUNCTION public.agent_expected_collection(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_expected_collection(uuid) TO authenticated, service_role;

-- 3. Enforce "no silent partials" in the agent allocation entry point.
--    Money, commission and ledger behaviour stay in _internal, untouched.
DROP FUNCTION IF EXISTS public.agent_allocate_tenant_payment(uuid, uuid, uuid, numeric, text);

CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
  p_agent_id uuid,
  p_tenant_id uuid,
  p_rent_request_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL::text,
  p_partial_confirmed boolean DEFAULT false,
  p_partial_reason text DEFAULT NULL::text
)
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

  -- Expected collection for this tenant (flat daily amount, capped at balance)
  v_expected := COALESCE(public.agent_expected_collection(p_rent_request_id), 0);
  v_shortfall := GREATEST(0, v_expected - COALESCE(p_amount, 0));
  v_is_partial := v_expected > 0 AND COALESCE(p_amount, 0) < v_expected;

  IF v_is_partial AND NOT COALESCE(p_partial_confirmed, false) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'PARTIAL_NOT_CONFIRMED',
      'error', format(
        'This tenant is expected to pay %s today. You entered %s, which is short by %s. Collect the full amount, or confirm this is a partial payment and give a reason.',
        v_expected, COALESCE(p_amount, 0), v_shortfall
      ),
      'expected_amount', v_expected,
      'entered_amount', COALESCE(p_amount, 0),
      'shortfall_amount', v_shortfall
    );
  END IF;

  IF v_is_partial AND (v_reason IS NULL OR length(v_reason) < 5) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'PARTIAL_REASON_REQUIRED',
      'error', 'A partial payment needs a short reason (at least 5 characters) so Operations can follow it up.',
      'expected_amount', v_expected,
      'entered_amount', COALESCE(p_amount, 0),
      'shortfall_amount', v_shortfall
    );
  END IF;

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

REVOKE ALL ON FUNCTION public.agent_allocate_tenant_payment(uuid, uuid, uuid, numeric, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_allocate_tenant_payment(uuid, uuid, uuid, numeric, text, boolean, text) TO authenticated, service_role;

-- 4. Operations follow-up report: derived from real amounts, no new status column.
CREATE OR REPLACE FUNCTION public.agent_ops_partial_collection_report(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_days integer := GREATEST(1, LEAST(365, COALESCE(p_days, 30)));
  v_from timestamptz;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'agent_ops'::public.app_role)
    OR public.has_role(v_uid, 'tenant_ops'::public.app_role)
    OR public.has_role(v_uid, 'landlord_ops'::public.app_role)
    OR public.has_role(v_uid, 'partner_ops'::public.app_role)
    OR public.has_role(v_uid, 'operations'::public.app_role)
    OR public.has_role(v_uid, 'manager'::public.app_role)
    OR public.has_role(v_uid, 'coo'::public.app_role)
    OR public.has_role(v_uid, 'ceo'::public.app_role)
    OR public.has_role(v_uid, 'super_admin'::public.app_role)
    OR public.has_role(v_uid, 'admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Operations role required' USING ERRCODE = '42501';
  END IF;

  v_from := now() - make_interval(days => v_days);

  WITH day_rows AS (
    SELECT ac.agent_id,
           ac.tenant_id,
           ac.rent_request_id,
           (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS collected_on,
           SUM(ac.amount) AS collected,
           MAX(ac.created_at) AS last_at,
           MAX(COALESCE(ac.partial_reason, '')) AS reason
      FROM public.agent_collections ac
     WHERE ac.created_at >= v_from
       AND ac.rent_request_id IS NOT NULL
     GROUP BY 1,2,3,4
  ), scored AS (
    SELECT d.*,
           COALESCE(rr.daily_repayment, 0) AS expected,
           GREATEST(0, COALESCE(rr.daily_repayment, 0) - d.collected) AS shortfall
      FROM day_rows d
      JOIN public.rent_requests rr ON rr.id = d.rent_request_id
  ), totals AS (
    SELECT COUNT(*) AS paid_days,
           COUNT(*) FILTER (WHERE shortfall > 0) AS partial_days,
           COALESCE(SUM(collected), 0) AS collected_total,
           COALESCE(SUM(expected), 0) AS expected_total,
           COALESCE(SUM(shortfall), 0) AS shortfall_total,
           COUNT(DISTINCT agent_id) FILTER (WHERE shortfall > 0) AS agents_affected,
           COUNT(DISTINCT tenant_id) FILTER (WHERE shortfall > 0) AS tenants_affected
      FROM scored
  ), by_agent AS (
    SELECT s.agent_id,
           COALESCE(pr.full_name, 'Unknown agent') AS agent_name,
           pr.phone AS agent_phone,
           COUNT(*) AS paid_days,
           COUNT(*) FILTER (WHERE s.shortfall > 0) AS partial_days,
           COALESCE(SUM(s.collected), 0) AS collected,
           COALESCE(SUM(s.expected), 0) AS expected,
           COALESCE(SUM(s.shortfall), 0) AS shortfall,
           COUNT(DISTINCT s.tenant_id) FILTER (WHERE s.shortfall > 0) AS tenants_short,
           MAX(s.last_at) AS last_collection_at
      FROM scored s
      LEFT JOIN public.profiles pr ON pr.id = s.agent_id
     GROUP BY 1,2,3
  ), by_tenant AS (
    SELECT s.tenant_id,
           s.rent_request_id,
           COALESCE(tp.full_name, 'Unknown tenant') AS tenant_name,
           tp.phone AS tenant_phone,
           COALESCE(ap.full_name, 'Unassigned') AS agent_name,
           s.agent_id,
           COUNT(*) AS paid_days,
           COUNT(*) FILTER (WHERE s.shortfall > 0) AS partial_days,
           COALESCE(SUM(s.collected), 0) AS collected,
           COALESCE(SUM(s.expected), 0) AS expected,
           COALESCE(SUM(s.shortfall), 0) AS shortfall,
           MAX(s.last_at) AS last_collection_at,
           MAX(NULLIF(s.reason, '')) AS last_reason
      FROM scored s
      LEFT JOIN public.profiles tp ON tp.id = s.tenant_id
      LEFT JOIN public.profiles ap ON ap.id = s.agent_id
     GROUP BY 1,2,3,4,5,6
  ), recent AS (
    SELECT ac.id,
           ac.created_at,
           ac.amount,
           ac.expected_amount,
           ac.shortfall_amount,
           ac.partial_reason,
           ac.payment_method::text AS payment_method,
           COALESCE(tp.full_name, 'Unknown tenant') AS tenant_name,
           tp.phone AS tenant_phone,
           COALESCE(ap.full_name, 'Unknown agent') AS agent_name
      FROM public.agent_collections ac
      LEFT JOIN public.profiles tp ON tp.id = ac.tenant_id
      LEFT JOIN public.profiles ap ON ap.id = ac.agent_id
     WHERE ac.created_at >= v_from
       AND ac.is_partial = true
     ORDER BY ac.created_at DESC
     LIMIT 300
  )
  SELECT jsonb_build_object(
    'days', v_days,
    'generated_at', now(),
    'totals', (SELECT to_jsonb(t) FROM totals t),
    'by_agent', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.shortfall DESC) FROM by_agent a), '[]'::jsonb),
    'by_tenant', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.shortfall DESC) FROM by_tenant b WHERE b.shortfall > 0), '[]'::jsonb),
    'confirmed_partials', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC) FROM recent r), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_ops_partial_collection_report(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_partial_collection_report(integer) TO authenticated, service_role;