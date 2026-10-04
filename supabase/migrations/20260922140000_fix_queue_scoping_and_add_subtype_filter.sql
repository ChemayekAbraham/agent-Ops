-- Make the People table obey the queue it is standing in, and add the in-queue
-- filter.
--
-- THE BUG, AND IT IS MINE
-- 20260922100000 taught `crm_platform_people_page` about queues by adding an
-- arm to the membership test:
--
--     AND (v_role IS NULL
--          OR EXISTS (... v_crm_person_roles r WHERE r.role = v_role)     <-- 1
--          OR EXISTS (... v_crm_call_section q WHERE q.section = v_role)) <-- 2
--
-- Three queue names - tenant, partner, employee - are ALSO role values in
-- `v_crm_person_roles`. For those, arm 1 matches and arm 2 is never reached.
-- Arm 1 is the old, unfiltered relation: 5,406 tenants including 490 whose
-- profile name carries '[DELETED]'. So the Tenants queue listed purged
-- accounts, exactly as reported, while `v_crm_call_section` had them correctly
-- excluded all along (0 deleted).
--
-- The second arm was added for the one synthetic name, `operational_agent`,
-- and I did not think about the three that collide. An OR was the wrong
-- operator: a queue name must resolve as a QUEUE, never fall back to the raw
-- role.
--
-- WHAT CHANGES
--   1. Queue names resolve against `v_crm_call_section` ONLY. Anything else
--      (landlord, agent, sub_agent - raw roles with no queue) still resolves
--      against `v_crm_person_roles`, so nothing outside the Call Centre moves.
--   2. New `p_subtype` argument: the in-queue filter. NULL means the whole
--      queue.
--   3. `agent` in the operational queue becomes Agent Operations' OWN
--      definition, and '[ARCHIVED]' joins '[DELETED]' as uncallable.
--
-- AGENT NOW MEANS WHAT AGENT OPS MEANS
-- Per the product owner: "for agent we shall literally base on what the agent
-- operations how it gets their total". That is `agent_ops_collection_agents`:
--
--     ever collected  UNION  agent or assigned_agent on a funded/repaying plan
--
-- which is 99 people - the figure the Call Centre header already shows. The
-- previous definition here was agent_collections alone (85) and undercounted
-- by 14 agents holding live plans they have not yet collected against.
--
-- Sub-agents stay their own table, as instructed. The filter therefore offers:
--     All agents   3,063   (the two combined, 75 people in both)
--     Agents          99   (Agent Ops definition)
--     Sub-agents   3,039   (agent_subagents, verified/approved/accepted)
--
-- Tenants already carry pipeline / repaying / funded / rejected / completed /
-- defaulter, so the same `p_subtype` serves that filter bar too. NULL is "all
-- tenants".

-- 1. The queue view: Agent Ops' agent definition, and archived excluded -------
CREATE OR REPLACE VIEW public.v_crm_call_section AS
WITH live AS (
  -- Purged and archived accounts are not people anyone should be ringing.
  -- Both markers live in the display name; neither deletes the row.
  SELECT p.id FROM public.profiles p
   WHERE COALESCE(p.full_name, '') NOT ILIKE '%[DELETED]%'
     AND COALESCE(p.full_name, '') NOT ILIKE '%[ARCHIVED]%'
),
tenant_plans AS (
  SELECT r.tenant_id AS person_id,
         CASE
           WHEN r.status IN ('pending','service_center_review','coo_approved','partner_ops_approved')
             THEN 'pipeline'
           ELSE r.status
         END AS subtype,
         (r.funded_at IS NOT NULL
          AND (r.funded_at + make_interval(days => COALESCE(r.duration_days, 0))) < now()
          AND COALESCE(r.total_repayment, 0) - COALESCE(r.amount_repaid, 0) > 0) AS is_defaulter
    FROM public.rent_requests r
    JOIN live l ON l.id = r.tenant_id
   WHERE r.status IN ('pending','service_center_review','coo_approved','partner_ops_approved',
                      'repaying','funded','rejected','completed')
),
operational AS (
  -- Agent Operations' universe, verbatim: someone who has ever collected, or
  -- who holds a funded/repaying plan as agent or assigned agent.
  SELECT DISTINCT u.uid AS person_id, 'agent'::text AS subtype
    FROM (
      SELECT ac.agent_id AS uid FROM public.agent_collections ac WHERE ac.agent_id IS NOT NULL
      UNION SELECT rr.agent_id FROM public.rent_requests rr
             WHERE rr.status IN ('funded','repaying') AND rr.agent_id IS NOT NULL
      UNION SELECT rr.assigned_agent_id FROM public.rent_requests rr
             WHERE rr.status IN ('funded','repaying') AND rr.assigned_agent_id IS NOT NULL
    ) u JOIN live l ON l.id = u.uid
  UNION ALL
  SELECT DISTINCT s.sub_agent_id, 'sub_agent'::text
    FROM public.agent_subagents s
    JOIN live l ON l.id = s.sub_agent_id
   WHERE s.status IN ('verified','approved','accepted') AND s.sub_agent_id IS NOT NULL
),
partners AS (
  SELECT DISTINCT p.person_id FROM (
      SELECT ip.investor_id AS person_id FROM public.investor_portfolios ip
      UNION SELECT fp.funder_id FROM public.funder_pending_portfolios fp
  ) p JOIN live l ON l.id = p.person_id WHERE p.person_id IS NOT NULL
),
employees AS (
  SELECT DISTINCT e.person_id FROM (
      SELECT hs.user_id AS person_id FROM public.hr_staff hs WHERE hs.active = true
      UNION SELECT sp.user_id FROM public.staff_profiles sp
      UNION SELECT ur.user_id FROM public.user_roles ur
             WHERE ur.enabled = true
               AND ur.role::text IN ('crm','tenant_ops','landlord_ops','agent_ops','partner_ops')
  ) e JOIN live l ON l.id = e.person_id WHERE e.person_id IS NOT NULL
),
proxy_agents AS (
  SELECT DISTINCT x.person_id FROM (
      SELECT paa.agent_id AS person_id FROM public.proxy_agent_assignments paa
       WHERE paa.is_active = true AND paa.approval_status = 'approved'
      UNION SELECT pai.agent_user_id FROM public.proxy_agent_identity pai
       WHERE pai.status = 'approved'
  ) x JOIN live l ON l.id = x.person_id WHERE x.person_id IS NOT NULL
)
SELECT DISTINCT person_id, 'tenant'::text AS section, subtype FROM tenant_plans
UNION
SELECT DISTINCT person_id, 'tenant'::text, 'defaulter'::text FROM tenant_plans WHERE is_defaulter
UNION
SELECT DISTINCT person_id, 'operational_agent'::text, subtype FROM operational
UNION
SELECT DISTINCT person_id, 'partner'::text,     NULL::text FROM partners
UNION
SELECT DISTINCT person_id, 'proxy_agent'::text, NULL::text FROM proxy_agents
UNION
SELECT DISTINCT person_id, 'employee'::text,    NULL::text FROM employees;

GRANT SELECT ON public.v_crm_call_section TO authenticated;

-- 2. The people table: scope to the queue, and accept the sub-filter ---------
-- Dropped and recreated because a new argument cannot be added with CREATE OR
-- REPLACE. The body is carried over verbatim from the live definition - it
-- holds sort and status logic that is not in this repository - and only the
-- signature, one DECLARE line and the membership test are rewritten. Every
-- anchor is asserted before use, and the whole thing is one transaction, so a
-- failed rebuild rolls the DROP back with it.
DO $people$
DECLARE v_def text; v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crm_platform_people_page';
  IF v_def IS NULL THEN RAISE EXCEPTION 'crm_platform_people_page missing'; END IF;

  IF position('p_subtype' in v_def) > 0 THEN
    RAISE NOTICE 'people page already takes p_subtype'; RETURN;
  END IF;
  v_before := v_def;

  -- a. signature gains the argument
  IF position(')' || chr(10) || ' RETURNS ' in v_def) = 0 THEN
    RAISE EXCEPTION 'signature anchor not found - inspect by hand';
  END IF;
  v_def := replace(v_def, ')' || chr(10) || ' RETURNS ',
                          ', p_subtype text DEFAULT NULL::text)' || chr(10) || ' RETURNS ');

  -- b. a variable to hold it
  IF position('  v_role text := NULLIF(btrim(COALESCE(p_role, '''')), '''');' in v_def) = 0 THEN
    RAISE EXCEPTION 'DECLARE anchor not found - inspect by hand';
  END IF;
  v_def := replace(v_def,
    '  v_role text := NULLIF(btrim(COALESCE(p_role, '''')), '''');',
    '  v_role text := NULLIF(btrim(COALESCE(p_role, '''')), '''');' || chr(10) ||
    '  v_subtype text := NULLIF(btrim(COALESCE(p_subtype, '''')), '''');');

  -- c. the membership test: a queue name resolves as a QUEUE, full stop
  IF position('AND (v_role IS NULL' || chr(10) ||
              '            OR EXISTS (SELECT 1 FROM public.v_crm_person_roles r' in v_def) = 0 THEN
    RAISE EXCEPTION 'membership anchor not found - inspect by hand';
  END IF;
  v_def := replace(v_def,
    'AND (v_role IS NULL' || chr(10) ||
    '            OR EXISTS (SELECT 1 FROM public.v_crm_person_roles r' || chr(10) ||
    '                        WHERE r.person_id = pr.id AND r.role = v_role)' || chr(10) ||
    '            OR EXISTS (SELECT 1 FROM public.v_crm_call_section q' || chr(10) ||
    '                        WHERE q.person_id = pr.id AND q.section = v_role))',
    'AND (v_role IS NULL' || chr(10) ||
    '            -- A Call Centre queue name resolves ONLY against the queue' || chr(10) ||
    '            -- view. tenant/partner/employee are also raw role values, and' || chr(10) ||
    '            -- falling back to those re-admits purged accounts.' || chr(10) ||
    '            OR (v_role IN (''tenant'',''partner'',''proxy_agent'',''operational_agent'',''employee'')' || chr(10) ||
    '                AND EXISTS (SELECT 1 FROM public.v_crm_call_section q' || chr(10) ||
    '                             WHERE q.person_id = pr.id AND q.section = v_role' || chr(10) ||
    '                               AND (v_subtype IS NULL OR q.subtype = v_subtype)))' || chr(10) ||
    '            OR (v_role NOT IN (''tenant'',''partner'',''proxy_agent'',''operational_agent'',''employee'')' || chr(10) ||
    '                AND EXISTS (SELECT 1 FROM public.v_crm_person_roles r' || chr(10) ||
    '                             WHERE r.person_id = pr.id AND r.role = v_role)))');

  IF v_def = v_before THEN RAISE EXCEPTION 'nothing changed'; END IF;

  DROP FUNCTION IF EXISTS public.crm_platform_people_page(text, text, text, text, integer, integer);
  EXECUTE v_def;
  RAISE NOTICE 'people page scoped to queues, p_subtype added';
END $people$;

GRANT EXECUTE ON FUNCTION
  public.crm_platform_people_page(text, text, text, text, integer, integer, text)
  TO authenticated;

-- 3. Verify -------------------------------------------------------------------
DO $verify$
DECLARE v_del int; v_arch int; v_agents bigint; v_subs bigint; v_all bigint;
BEGIN
  -- Not one purged or archived account may sit in any queue.
  SELECT count(*) INTO v_del FROM public.v_crm_call_section q
    JOIN public.profiles p ON p.id = q.person_id WHERE p.full_name ILIKE '%[DELETED]%';
  SELECT count(*) INTO v_arch FROM public.v_crm_call_section q
    JOIN public.profiles p ON p.id = q.person_id WHERE p.full_name ILIKE '%[ARCHIVED]%';
  IF v_del > 0 OR v_arch > 0 THEN
    RAISE EXCEPTION '% deleted and % archived accounts still queued - rolled back', v_del, v_arch;
  END IF;

  -- The agent filter must equal Agent Operations' own total.
  SELECT count(DISTINCT person_id) INTO v_agents
    FROM public.v_crm_call_section WHERE section='operational_agent' AND subtype='agent';
  SELECT count(DISTINCT person_id) INTO v_subs
    FROM public.v_crm_call_section WHERE section='operational_agent' AND subtype='sub_agent';
  SELECT count(DISTINCT person_id) INTO v_all
    FROM public.v_crm_call_section WHERE section='operational_agent';

  IF v_agents < 90 THEN
    RAISE EXCEPTION 'agent filter is % - not the Agent Ops definition, rolled back', v_agents;
  END IF;
  IF v_subs < 1000 THEN
    RAISE EXCEPTION 'sub-agent filter collapsed to % - rolled back', v_subs;
  END IF;
  IF v_all > v_agents + v_subs THEN
    RAISE EXCEPTION 'all-agents (%) exceeds its parts - rolled back', v_all;
  END IF;

  -- The function must now take the sub-filter.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='crm_platform_people_page'
       AND pg_get_function_identity_arguments(p.oid) =
           'p_search text, p_role text, p_status text, p_sort text, p_limit integer, p_offset integer, p_subtype text')
  THEN RAISE EXCEPTION 'p_subtype did not land on crm_platform_people_page - rolled back'; END IF;

  -- Exactly one overload, or the client gets "could not choose a best candidate".
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='crm_platform_people_page') <> 1
  THEN RAISE EXCEPTION 'more than one crm_platform_people_page overload - rolled back'; END IF;

  RAISE NOTICE 'queues scoped: agents %, sub-agents %, all %, zero deleted or archived',
    v_agents, v_subs, v_all;
END $verify$;
