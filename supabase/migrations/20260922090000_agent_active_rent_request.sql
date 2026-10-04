-- Self-scoped "which rent request should a collection apply to" for the
-- native Android app's collect-payment feature.
--
-- Why this can't just be a client-side `.from('rent_requests').select(...)`:
-- rent_requests' only agent-facing RLS SELECT policy is
-- `auth.uid() = agent_id` ("Agents view requests they registered") — there
-- is no policy for `assigned_agent_id`. agent_allocate_tenant_payment and
-- get_agent_tenants_overview both bypass this via SECURITY DEFINER and check
-- `agent_id = auth.uid() OR assigned_agent_id = auth.uid() OR <verified
-- subagent>` themselves. A direct client query would silently return zero
-- rows (or the wrong "active" plan) for a tenant assigned via
-- assigned_agent_id only, even though the agent legitimately owns that
-- collection. This mirrors the same ownership check instead of querying the
-- table directly.
--
-- "Active" selection exactly matches TenantProfileView.tsx's activeRequest:
-- among a tenant's rent_requests (newest first), the first row in
-- ('approved','funded','disbursed','repaying') that still owes money, or —
-- only if none of those exist — the first 'rejected' outstanding_balance row
-- that still owes money.

CREATE OR REPLACE FUNCTION public.get_agent_active_rent_request(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT rr.id, rr.status, rr.total_repayment, rr.amount_repaid, rr.registration_type,
         rr.repayment_starts_on, rr.funded_at, rr.disbursed_at, rr.created_at,
         rr.daily_repayment
    INTO v_row
    FROM public.rent_requests rr
   WHERE rr.tenant_id = p_tenant_id
     AND (
       rr.agent_id = v_uid
       OR rr.assigned_agent_id = v_uid
       OR EXISTS (
         SELECT 1 FROM public.agent_subagents sa
          WHERE sa.parent_agent_id = v_uid
            AND sa.sub_agent_id IN (rr.agent_id, rr.assigned_agent_id)
            AND sa.status IN ('verified', 'approved', 'accepted')
       )
     )
     AND (
       (rr.status IN ('approved', 'funded', 'disbursed', 'repaying')
        AND COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) > 0)
       OR
       (rr.status = 'rejected' AND rr.registration_type = 'outstanding_balance'
        AND COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) > 0)
     )
   ORDER BY
     CASE WHEN rr.status IN ('approved', 'funded', 'disbursed', 'repaying') THEN 0 ELSE 1 END,
     rr.created_at DESC
   LIMIT 1;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'id', v_row.id,
    'status', v_row.status,
    'total_repayment', v_row.total_repayment,
    'amount_repaid', v_row.amount_repaid,
    'outstanding', GREATEST(0, COALESCE(v_row.total_repayment, 0) - COALESCE(v_row.amount_repaid, 0)),
    'registration_type', v_row.registration_type,
    'repayment_starts_on', COALESCE(
      v_row.repayment_starts_on,
      (COALESCE(v_row.funded_at, v_row.disbursed_at, v_row.created_at) AT TIME ZONE 'Africa/Kampala')::date
    ),
    'daily_repayment', v_row.daily_repayment
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_active_rent_request(uuid) TO authenticated;
