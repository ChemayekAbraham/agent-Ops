CREATE OR REPLACE VIEW public.v_crm_person_roles AS
 SELECT DISTINCT rr.tenant_id AS person_id, 'tenant'::text AS role
   FROM rent_requests rr
  WHERE rr.tenant_id IS NOT NULL
UNION
 SELECT DISTINCT a.person_id, 'agent'::text AS role
   FROM (
     SELECT rr.agent_id AS person_id FROM rent_requests rr
      WHERE rr.status = ANY (ARRAY['funded'::text,'repaying'::text]) AND rr.agent_id IS NOT NULL
     UNION
     SELECT ac.agent_id FROM agent_collections ac WHERE ac.agent_id IS NOT NULL
     UNION
     SELECT rr2.assigned_agent_id FROM rent_requests rr2
      WHERE rr2.status = ANY (ARRAY['funded'::text,'repaying'::text]) AND rr2.assigned_agent_id IS NOT NULL
   ) a
  WHERE a.person_id IS NOT NULL
UNION
 SELECT DISTINCT s.sub_agent_id AS person_id, 'sub_agent'::text AS role
   FROM agent_subagents s
  WHERE s.status = 'verified'::text
    AND s.sub_agent_id IS NOT NULL
    AND s.sub_agent_id IN (
      SELECT rr.agent_id FROM rent_requests rr
       WHERE rr.status = ANY (ARRAY['funded'::text,'repaying'::text]) AND rr.agent_id IS NOT NULL
      UNION
      SELECT ac.agent_id FROM agent_collections ac WHERE ac.agent_id IS NOT NULL
      UNION
      SELECT rr2.assigned_agent_id FROM rent_requests rr2
       WHERE rr2.status = ANY (ARRAY['funded'::text,'repaying'::text]) AND rr2.assigned_agent_id IS NOT NULL
    )
UNION
 SELECT DISTINCT p.person_id, 'partner'::text AS role
   FROM ( SELECT investor_portfolios.investor_id AS person_id FROM investor_portfolios
          UNION
          SELECT funder_pending_portfolios.funder_id FROM funder_pending_portfolios) p
  WHERE p.person_id IS NOT NULL
UNION
 SELECT DISTINCT l.person_id, 'landlord'::text AS role
   FROM ( SELECT agent_landlord_float_allocations.landlord_id AS person_id FROM agent_landlord_float_allocations
          UNION
          SELECT landlord_payouts.landlord_id FROM landlord_payouts
           WHERE landlord_payouts.status = ANY (ARRAY['awaiting_agent_receipt'::text,'completed'::text])) l
  WHERE l.person_id IS NOT NULL
UNION
 SELECT DISTINCT ur.user_id AS person_id, 'employee'::text AS role
   FROM user_roles ur
  WHERE ur.enabled = true AND ur.role = 'employee'::app_role AND ur.user_id IS NOT NULL;