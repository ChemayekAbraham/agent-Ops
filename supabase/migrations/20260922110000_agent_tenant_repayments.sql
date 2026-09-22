-- Self-scoped "this tenant's repayments rows, for an agent authorized to
-- see them" — for the native Android app's full payment-history merge
-- feature (agent_collections + repayments, matching TenantProfileView.tsx's
-- buildPlanRepaymentHistory exactly).
--
-- Why this needs its own RPC: `repayments`' only SELECT policies are
-- `auth.uid() = tenant_id` (self) and a handful of staff roles (manager,
-- super_admin, ceo, coo, cfo, operations) — there is NO policy allowing an
-- agent to read their own tenant's repayments. TenantProfileView.tsx's own
-- repayment-history merge queries `repayments` filtered by tenant_id
-- directly and has been silently returning zero rows for any agent without
-- a staff role — the same class of gap as docs 105 (rent_requests) and 107
-- (landlords), just on a fourth table.

CREATE OR REPLACE FUNCTION public.get_agent_tenant_repayments(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_authorized boolean;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.rent_requests rr
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
  ) INTO v_authorized;

  IF NOT v_authorized THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id,
    'rent_request_id', x.rent_request_id,
    'amount', x.amount,
    'created_at', x.created_at,
    'payment_method', x.payment_method
  )), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT r.id, r.rent_request_id, r.amount, r.created_at, r.payment_method
      FROM public.repayments r
     WHERE r.tenant_id = p_tenant_id
     ORDER BY r.created_at DESC
     LIMIT 200
  ) x;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_tenant_repayments(uuid) TO authenticated;
