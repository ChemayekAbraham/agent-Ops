CREATE OR REPLACE VIEW public.v_crm_person_roles AS
  SELECT DISTINCT tenant_id AS person_id, 'tenant'::text AS role
    FROM public.rent_requests
   WHERE tenant_id IS NOT NULL
  UNION
  SELECT DISTINCT a.person_id, 'agent'::text
    FROM (
      SELECT agent_id AS person_id FROM public.agent_ops_strict_agent_ids()
      UNION
      SELECT sub_agent_id FROM public.agent_subagents WHERE status = 'verified'
    ) a
   WHERE a.person_id IS NOT NULL
  UNION
  SELECT DISTINCT p.person_id, 'partner'::text
    FROM (
      SELECT investor_id AS person_id FROM public.investor_portfolios
      UNION SELECT funder_id FROM public.funder_pending_portfolios
    ) p
   WHERE p.person_id IS NOT NULL
  UNION
  SELECT DISTINCT l.person_id, 'landlord'::text
    FROM (
      SELECT landlord_id AS person_id FROM public.agent_landlord_float_allocations
      UNION
      SELECT landlord_id FROM public.landlord_payouts
       WHERE status IN ('awaiting_agent_receipt','completed')
    ) l
   WHERE l.person_id IS NOT NULL
  UNION
  SELECT DISTINCT user_id, 'employee'::text
    FROM public.user_roles
   WHERE enabled = true AND role = 'employee' AND user_id IS NOT NULL;

GRANT SELECT ON public.v_crm_person_roles TO service_role;