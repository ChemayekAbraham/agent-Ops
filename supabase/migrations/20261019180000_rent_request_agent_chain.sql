-- Who is behind a rent request's agent: the registering agent, whether they are a VERIFIED sub-agent, their main (parent) agent, and the assigned
-- agent, each with their own name and phone. ONE NEW read-only function; nothing existing is altered, no status, routing, commission or approval
-- logic is touched, no index is added.
--
--   rent_request_agent_chain(p_request_ids uuid[])   one row per found request (at most 200 ids per call)
--
-- Definitions (the only ones; also in supabase/AGENTS.md):
--   registering agent   rent_requests.agent_id
--   assigned agent      rent_requests.assigned_agent_id (null when none); assigned_differs = it is set and is a different person
--   verified sub-agent  the registering agent has an agent_subagents row with status = 'verified' (a pending, expired or rejected link is not one)
--   main (parent) agent agent_subagents.parent_agent_id of that verified link; if the agent has several verified links the earliest verified one
--                       (verified_at, then created_at) is used, the same rule as the Agent Ops metrics. Null when there is no verified link.
--   every phone         comes from the profile of the person named next to it: registering_agent_phone belongs to registering_agent_name,
--                       parent_agent_phone to parent_agent_name, assigned_agent_phone to assigned_agent_name.
--
-- Access: auth.uid() required; the caller must hold an enabled desk role that reads the rent pipeline (manager, super_admin, coo, operations, ceo, cto,
-- cfo, agent_ops, landlord_ops, tenant_ops, partner_ops, financial_ops), else SQLSTATE 42501. Agents and tenants cannot call it. More than 200 ids is
-- 22023 TOO_MANY_IDS. SECURITY DEFINER, STABLE, search_path = public. EXECUTE for authenticated only. Ids that do not exist are simply left out.
-- Rollback: supabase/rollbacks/20261019180000_rent_request_agent_chain.rollback.sql

CREATE OR REPLACE FUNCTION public.rent_request_agent_chain(p_request_ids uuid[])
RETURNS TABLE (
  request_id uuid,
  registering_agent_id uuid, registering_agent_name text, registering_agent_phone text,
  is_verified_subagent boolean,
  parent_agent_id uuid, parent_agent_name text, parent_agent_phone text,
  assigned_agent_id uuid, assigned_agent_name text, assigned_agent_phone text,
  assigned_differs boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'manager'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role) OR public.has_role(v_uid, 'coo'::app_role)
    OR public.has_role(v_uid, 'operations'::app_role) OR public.has_role(v_uid, 'ceo'::app_role) OR public.has_role(v_uid, 'cto'::app_role)
    OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'agent_ops'::app_role) OR public.has_role(v_uid, 'landlord_ops'::app_role)
    OR public.has_role(v_uid, 'tenant_ops'::app_role) OR public.has_role(v_uid, 'partner_ops'::app_role) OR public.has_role(v_uid, 'financial_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_ids FROM unnest(COALESCE(p_request_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL;
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION 'TOO_MANY_IDS: at most 200 request ids per call' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT r.id,
         r.agent_id, rp.full_name, rp.phone,
         (par.parent_agent_id IS NOT NULL),
         par.parent_agent_id, pp.full_name, pp.phone,
         r.assigned_agent_id, ap.full_name, ap.phone,
         (r.assigned_agent_id IS NOT NULL AND r.assigned_agent_id IS DISTINCT FROM r.agent_id)
    FROM public.rent_requests r
    LEFT JOIN public.profiles rp ON rp.id = r.agent_id
    LEFT JOIN LATERAL (
      SELECT s.parent_agent_id FROM public.agent_subagents s
       WHERE s.sub_agent_id = r.agent_id AND s.status = 'verified'
       ORDER BY s.verified_at NULLS LAST, s.created_at LIMIT 1
    ) par ON true
    LEFT JOIN public.profiles pp ON pp.id = par.parent_agent_id
    LEFT JOIN public.profiles ap ON ap.id = r.assigned_agent_id
   WHERE r.id = ANY (v_ids);
END;
$function$;

COMMENT ON FUNCTION public.rent_request_agent_chain(uuid[]) IS 'Registering agent, verified sub-agent flag, main agent and assigned agent (each with their own phone) for a batch of rent requests. Read-only.';

REVOKE ALL ON FUNCTION public.rent_request_agent_chain(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.rent_request_agent_chain(uuid[]) TO authenticated;
