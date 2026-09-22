-- CRM Call Centre: five audience queues instead of one flat roster.
--
-- WHAT IS BEING BUILT
-- The Call Centre becomes five sections - Tenants, Partners, Proxy Agents,
-- Operational Agents, Employees - each with the same four views
-- (Overview, People, Call Logs, Summaries). This migration supplies the data
-- layer; the views themselves are shared components on the frontend.
--
-- THE ONE REAL MODELLING DECISION: QUEUES OVERLAP
-- `v_crm_call_audience` assigns each person EXACTLY ONE `primary_role` by
-- precedence. That is the wrong shape for a call centre, and the proxy agents
-- prove it. Of the 83 approved proxy agents:
--
--      41 are employees
--      33 are partners
--       7 are operational agents
--       2 are in no audience at all
--
-- Under exclusive precedence, ranking Proxy Agents above Employees empties the
-- Employees queue from 55 to 14; ranking it below leaves the Proxy Agents queue
-- holding 9 people. Neither is what anyone wants, because the premise is wrong:
-- a section is a REASON TO CALL SOMEONE, not a statement about who they are.
-- The same person is legitimately called about their proxy duties and about
-- their employment, by different desks, on different days.
--
-- So `v_crm_call_section` is MANY rows per person - one per queue they belong
-- to. Section totals deliberately sum to more than the headcount.
--
-- `v_crm_call_audience` is left exactly as it is. It still answers "if I may
-- show only one label for this person, which?" and the dialer still needs that.
-- Nothing that reads it changes behaviour.
--
-- WHO IS A PROXY AGENT (product owner, 2026-09-22)
-- An active, approved row in `proxy_agent_assignments`, OR an approved
-- `proxy_agent_identity`. 83 people. Two of them are reachable from the Call
-- Centre for the first time.
--
-- WHAT `operational_agent` MEANS
-- Agents AND sub-agents in one queue - the people collecting rent on the
-- ground. The existing audience view already folded sub-agents in under
-- 'agent'; this only renames the concept. Proxy agents are NOT subtracted:
-- under overlapping queues the 7 who also collect appear in both, exactly as
-- the 41 who are also employees do.

-- 1. The queues -------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_crm_call_section AS
WITH tenants AS (
  SELECT DISTINCT rr.tenant_id AS person_id
    FROM public.rent_requests rr WHERE rr.tenant_id IS NOT NULL
), operational_agents AS (
  -- DELIBERATELY NOT `user_roles.role = 'agent'`. That row is handed out at
  -- signup: 58,661 accounts carry it, and the existing audience view's agent
  -- bucket is 58,086 people as a result. An agent, for calling purposes, is
  -- someone who actually collects - which is what v_crm_person_roles already
  -- encodes (99 agents + 76 sub-agents).
  SELECT DISTINCT r.person_id
    FROM public.v_crm_person_roles r
   WHERE r.role IN ('agent', 'sub_agent') AND r.person_id IS NOT NULL
), partners AS (
  SELECT DISTINCT p.person_id FROM (
      SELECT ip.investor_id AS person_id FROM public.investor_portfolios ip
      UNION SELECT fp.funder_id FROM public.funder_pending_portfolios fp
  ) p WHERE p.person_id IS NOT NULL
), employees AS (
  SELECT DISTINCT e.person_id FROM (
      SELECT hs.user_id AS person_id FROM public.hr_staff hs WHERE hs.active = true
      UNION SELECT sp.user_id FROM public.staff_profiles sp
  ) e WHERE e.person_id IS NOT NULL
), proxy_agents AS (
  -- Active duty, or approved and waiting to be assigned. Both are people the
  -- proxy desk calls.
  SELECT DISTINCT x.person_id FROM (
      SELECT paa.agent_id AS person_id FROM public.proxy_agent_assignments paa
       WHERE paa.is_active = true AND paa.approval_status = 'approved'
      UNION SELECT pai.agent_user_id FROM public.proxy_agent_identity pai
       WHERE pai.status = 'approved'
  ) x WHERE x.person_id IS NOT NULL
)
SELECT person_id, 'tenant'::text            AS section FROM tenants
UNION ALL SELECT person_id, 'partner'            FROM partners
UNION ALL SELECT person_id, 'proxy_agent'        FROM proxy_agents
UNION ALL SELECT person_id, 'operational_agent'  FROM operational_agents
UNION ALL SELECT person_id, 'employee'           FROM employees;

COMMENT ON VIEW public.v_crm_call_section IS
  'CRM Call Centre queues. MANY rows per person - a section is a reason to call '
  'someone, not an identity, so totals sum to more than the headcount. Use '
  'v_crm_call_audience instead when exactly one label is required.';

GRANT SELECT ON public.v_crm_call_section TO authenticated;

-- 2. Every role a person holds, for row badges -------------------------------
-- Additive: `proxy_agent` joins the existing six. Nothing filtering on the old
-- values changes.
CREATE OR REPLACE VIEW public.v_crm_person_roles AS
SELECT DISTINCT rr.tenant_id AS person_id, 'tenant'::text AS role
  FROM public.rent_requests rr WHERE rr.tenant_id IS NOT NULL
UNION
SELECT DISTINCT a.person_id, 'agent'::text FROM (
    SELECT rr.agent_id AS person_id FROM public.rent_requests rr
     WHERE rr.status = ANY (ARRAY['funded','repaying']) AND rr.agent_id IS NOT NULL
    UNION SELECT ac.agent_id FROM public.agent_collections ac WHERE ac.agent_id IS NOT NULL
    UNION SELECT rr2.assigned_agent_id FROM public.rent_requests rr2
     WHERE rr2.status = ANY (ARRAY['funded','repaying']) AND rr2.assigned_agent_id IS NOT NULL
) a WHERE a.person_id IS NOT NULL
UNION
SELECT DISTINCT s.sub_agent_id, 'sub_agent'::text
  FROM public.agent_subagents s
 WHERE s.status = 'verified' AND s.sub_agent_id IS NOT NULL
   AND s.sub_agent_id IN (
     SELECT rr.agent_id FROM public.rent_requests rr
      WHERE rr.status = ANY (ARRAY['funded','repaying']) AND rr.agent_id IS NOT NULL
     UNION SELECT ac.agent_id FROM public.agent_collections ac WHERE ac.agent_id IS NOT NULL
     UNION SELECT rr2.assigned_agent_id FROM public.rent_requests rr2
      WHERE rr2.status = ANY (ARRAY['funded','repaying']) AND rr2.assigned_agent_id IS NOT NULL)
UNION
SELECT DISTINCT p.person_id, 'partner'::text FROM (
    SELECT ip.investor_id AS person_id FROM public.investor_portfolios ip
    UNION SELECT fp.funder_id FROM public.funder_pending_portfolios fp
) p WHERE p.person_id IS NOT NULL
UNION
SELECT DISTINCT l.person_id, 'landlord'::text FROM (
    SELECT alfa.landlord_id AS person_id FROM public.agent_landlord_float_allocations alfa
    UNION SELECT lp.landlord_id FROM public.landlord_payouts lp
     WHERE lp.status = ANY (ARRAY['awaiting_agent_receipt','completed'])
) l WHERE l.person_id IS NOT NULL
UNION
SELECT DISTINCT ur.user_id, 'employee'::text
  FROM public.user_roles ur
 WHERE ur.enabled = true AND ur.role = 'employee'::app_role AND ur.user_id IS NOT NULL
UNION
SELECT DISTINCT x.person_id, 'proxy_agent'::text FROM (
    SELECT paa.agent_id AS person_id FROM public.proxy_agent_assignments paa
     WHERE paa.is_active = true AND paa.approval_status = 'approved'
    UNION SELECT pai.agent_user_id FROM public.proxy_agent_identity pai
     WHERE pai.status = 'approved'
) x WHERE x.person_id IS NOT NULL;

-- 3. The roster, filtered by queue -------------------------------------------
-- Return shape is UNCHANGED so nothing on the frontend breaks. Only the
-- membership test moves from "primary_role equals" to "belongs to the queue",
-- and the role column reports the queue being browsed rather than the person's
-- single precedence label - which is the honest answer to "why am I looking at
-- this person" once queues overlap.
CREATE OR REPLACE FUNCTION public.crm_call_roster_page(
  p_search text DEFAULT NULL,
  p_role   text DEFAULT NULL,
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0)
-- Column names are the LIVE ones, unchanged. `CREATE OR REPLACE FUNCTION`
-- cannot rename an OUT parameter, and the roster hook reads these by name.
RETURNS TABLE(person_id uuid, name text, phone_masked text, has_phone boolean,
              primary_role text, location text, avatar_url text, total_calls integer,
              summaries integer, first_called_at timestamptz, last_called_at timestamptz,
              last_status text, last_hangup_cause text, last_duration_seconds integer,
              last_call_id uuid, total_rows bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_section text := NULLIF(btrim(COALESCE(p_role, '')), '');
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  WITH people AS (
    SELECT DISTINCT s.person_id FROM public.v_crm_call_section s
     WHERE v_section IS NULL OR s.section = v_section
  ),
  base AS (
    SELECT pe.person_id,
           COALESCE(v_section, a.primary_role, 'tenant') AS primary_role,
           p.full_name, p.phone, p.avatar_url,
           COALESCE(NULLIF(p.district, ''), NULLIF(p.city, ''), NULLIF(p.region, '')) AS loc
      FROM people pe
      JOIN public.profiles p ON p.id = pe.person_id
      LEFT JOIN public.v_crm_call_audience a ON a.person_id = pe.person_id
     WHERE (v_search IS NULL
            OR p.full_name ILIKE '%' || v_search || '%'
            OR regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')
               LIKE '%' || regexp_replace(v_search, '\D', '', 'g') || '%')
  ),
  agg AS (
    SELECT s.target_user_id,
           COUNT(*)::int AS calls,
           COUNT(*) FILTER (WHERE btrim(COALESCE(s.summary, '')) <> '')::int AS notes,
           MIN(s.created_at) AS first_at,
           MAX(s.created_at) AS last_at
      FROM public.crm_call_sessions s
     WHERE s.target_user_id IS NOT NULL
     GROUP BY s.target_user_id
  ),
  counted AS (SELECT COUNT(*) AS n FROM base)
  SELECT b.person_id,
         COALESCE(NULLIF(btrim(b.full_name), ''), 'Unnamed user'),
         public.crm_mask_phone(b.phone),
         public.normalize_ug_phone(b.phone) IS NOT NULL,
         b.primary_role,
         b.loc,
         b.avatar_url,
         COALESCE(g.calls, 0),
         COALESCE(g.notes, 0),
         g.first_at,
         g.last_at,
         last.status,
         last.hangup_cause,
         last.duration_seconds,
         last.id,
         (SELECT n FROM counted)
    FROM base b
    LEFT JOIN agg g ON g.target_user_id = b.person_id
    LEFT JOIN LATERAL (
      SELECT s.id, s.status, s.hangup_cause, s.duration_seconds
        FROM public.crm_call_sessions s
       WHERE s.target_user_id = b.person_id
       ORDER BY s.created_at DESC
       LIMIT 1
    ) last ON true
   ORDER BY COALESCE(g.last_at, '-infinity'::timestamptz) DESC, b.full_name ASC
   LIMIT v_limit OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$fn$;

-- 4. Queue sizes, for the "Total Numbers" KPI --------------------------------
CREATE OR REPLACE FUNCTION public.crm_call_section_counts()
RETURNS TABLE(section text, people bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT s.section, COUNT(DISTINCT s.person_id)
    FROM public.v_crm_call_section s
    JOIN public.profiles p ON p.id = s.person_id
   WHERE public.crm_call_centre_authorized(auth.uid())
   GROUP BY s.section;
$fn$;

GRANT EXECUTE ON FUNCTION public.crm_call_section_counts() TO authenticated;

COMMENT ON FUNCTION public.crm_call_section_counts() IS
  'People per Call Centre queue. Totals sum to MORE than the platform headcount '
  'because queues overlap by design - see v_crm_call_section.';

-- 5. Call logs, filtered by queue --------------------------------------------
-- Dropped and recreated rather than overloaded: two arities of a function the
-- frontend calls by name is how you get "could not choose a best candidate"
-- at runtime. The new argument defaults to NULL, so existing three-argument
-- callers keep working unchanged.
DROP FUNCTION IF EXISTS public.crm_call_sessions_feed(integer, integer, uuid);

CREATE OR REPLACE FUNCTION public.crm_call_sessions_feed(
  p_days integer DEFAULT 30,
  p_limit integer DEFAULT 1000,
  p_target_user_id uuid DEFAULT NULL,
  p_section text DEFAULT NULL,
  p_with_summary_only boolean DEFAULT false)
RETURNS TABLE(id uuid, target_user_id uuid, target_name text, target_phone_masked text,
              target_role text, target_location text, status text, hangup_cause text,
              duration_seconds integer, created_at timestamptz, staff_id uuid,
              staff_name text, summary text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_section text := NULLIF(btrim(COALESCE(p_section, '')), '');
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT s.id, s.target_user_id, s.target_name, public.crm_mask_phone(s.target_phone),
         s.target_role, s.target_location, s.status, s.hangup_cause, s.duration_seconds,
         s.created_at, s.staff_id,
         COALESCE(NULLIF(btrim(sp.full_name), ''), 'Staff'),
         s.summary
    FROM public.crm_call_sessions s
    LEFT JOIN public.profiles sp ON sp.id = s.staff_id
   WHERE s.direction = 'Outbound'
     AND s.created_at >= now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365))
     AND (p_target_user_id IS NULL OR s.target_user_id = p_target_user_id)
     -- Membership is read LIVE, not from s.target_role. That column is a
     -- snapshot written when the call was placed and goes stale the moment
     -- someone becomes a proxy agent or stops being one.
     AND (v_section IS NULL OR EXISTS (
           SELECT 1 FROM public.v_crm_call_section q
            WHERE q.person_id = s.target_user_id AND q.section = v_section))
     AND (NOT p_with_summary_only OR btrim(COALESCE(s.summary, '')) <> '')
   ORDER BY s.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.crm_call_sessions_feed(integer, integer, uuid, text, boolean) TO authenticated;

-- 6. Let the people table filter by queue too ---------------------------------
-- `crm_platform_people_page` already filters on `v_crm_person_roles`, so adding
-- `proxy_agent` there (step 2) made that queue work for free. Only the
-- synthetic `operational_agent` has no matching role value, so the membership
-- test gains a second arm against the queue view.
--
-- Patched in place rather than restated: the function carries sort and status
-- logic that is not in this repository, and restating would clobber it.
DO $people$
DECLARE v_def text; v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crm_platform_people_page';
  IF v_def IS NULL THEN RAISE EXCEPTION 'crm_platform_people_page missing'; END IF;

  IF position('v_crm_call_section' in v_def) > 0 THEN
    RAISE NOTICE 'people page already queue-aware'; RETURN;
  END IF;
  v_before := v_def;

  v_def := replace(v_def,
    'AND (v_role IS NULL OR EXISTS (' || chr(10) ||
    '             SELECT 1 FROM public.v_crm_person_roles r' || chr(10) ||
    '              WHERE r.person_id = pr.id AND r.role = v_role))',
    'AND (v_role IS NULL' || chr(10) ||
    '            OR EXISTS (SELECT 1 FROM public.v_crm_person_roles r' || chr(10) ||
    '                        WHERE r.person_id = pr.id AND r.role = v_role)' || chr(10) ||
    '            OR EXISTS (SELECT 1 FROM public.v_crm_call_section q' || chr(10) ||
    '                        WHERE q.person_id = pr.id AND q.section = v_role))');

  IF v_def = v_before THEN
    RAISE EXCEPTION 'role filter anchor not found in crm_platform_people_page - inspect by hand';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'crm_platform_people_page now accepts queue names';
END $people$;

-- 7. Verify -------------------------------------------------------------------
DO $verify$
DECLARE v_proxies bigint; v_employees bigint; v_sections int;
BEGIN
  SELECT COUNT(DISTINCT section) INTO v_sections FROM public.v_crm_call_section;
  IF v_sections <> 5 THEN
    RAISE EXCEPTION 'expected 5 queues, found % - rolled back', v_sections;
  END IF;

  SELECT COUNT(DISTINCT person_id) INTO v_proxies
    FROM public.v_crm_call_section WHERE section = 'proxy_agent';
  IF v_proxies = 0 THEN
    RAISE EXCEPTION 'proxy_agent queue is empty - the predicate is wrong, rolled back';
  END IF;

  -- The whole point of overlapping queues: the employees queue must NOT have
  -- been drained by the proxy agents queue.
  SELECT COUNT(DISTINCT person_id) INTO v_employees
    FROM public.v_crm_call_section WHERE section = 'employee';
  IF v_employees < 50 THEN
    RAISE EXCEPTION 'employee queue collapsed to % - queues are behaving exclusively, rolled back', v_employees;
  END IF;

  IF (SELECT COUNT(*) FROM public.v_crm_person_roles WHERE role = 'proxy_agent') = 0 THEN
    RAISE EXCEPTION 'proxy_agent badge missing from v_crm_person_roles - rolled back';
  END IF;

  RAISE NOTICE 'five queues live: % proxy agents, % employees, overlapping as intended',
    v_proxies, v_employees;
END $verify$;