-- Correct the Call Centre queue definitions, and give each queue a sub-filter.
--
-- Supersedes the queue predicates in 20260922100000. Run that one FIRST - this
-- migration only replaces the view and the two functions that read it; the
-- rest of 20260922100000 (crm_call_section_counts, the roster rewrite, the
-- people-page patch, the feed arguments) is still required.
--
-- WHAT WAS WRONG IN 20260922100000
--
-- 1. SUB-AGENTS WERE INVISIBLE. `operational_agent` read `v_crm_person_roles`
--    where role IN ('agent','sub_agent'). That view only records a sub-agent
--    who ALSO appears in the collecting set, so the 76 it reported were a
--    subset of the 99 agents, not an addition. The real sub-agent population
--    lives in `agent_subagents` and is 32,219 verified rows.
--
-- 2. DELETED ACCOUNTS WERE COUNTED. 37,776 profiles carry the '[Deleted]'
--    name marker from the bot-signup purges. They dominate some queues:
--    verified sub-agents fall from 32,219 to 3,043 once they are excluded.
--    Calling one is calling a purged account.
--
-- 3. "TENANT" MEANT "HAS EVER HAD A RENT REQUEST", including cancelled and
--    agent-deleted plans. The queue is now the six states worth calling about.
--
-- THE SHAPE, PER THE PRODUCT OWNER (2026-09-22)
--   operational_agent  someone with agent_collections rows, LITERALLY, plus
--                      sub-agents from their own table - one queue, with a
--                      filter to narrow to either.
--   tenant             pipeline, repaying, funded, rejected, completed, and
--                      defaulters (term expired with a balance outstanding).
--
-- SUBTYPE: THE IN-QUEUE FILTER
-- `v_crm_call_section` gains a third column. It is what the table's filter bar
-- binds to, and it is why one view can serve both "agents vs sub-agents" and
-- "which stage is this tenant at" without a second concept.
--
--   operational_agent -> 'agent' | 'sub_agent'
--   tenant            -> 'pipeline' | 'repaying' | 'funded' | 'rejected'
--                        | 'completed' | 'defaulter'
--   everything else   -> NULL
--
-- A person can hold SEVERAL subtypes in one queue - 64 of the 85 agents are
-- also sub-agents, and a tenant with two plans can be repaying on one and in
-- the pipeline on another. Rows multiply accordingly; count DISTINCT person_id
-- for queue sizes, which `crm_call_section_counts` already does.
--
-- DEFAULTER IS A SUBTYPE, NOT A SEVENTH STATUS. A defaulter is a funded or
-- repaying plan whose term has run out with money still owed, so the same plan
-- is in both 'repaying' and 'defaulter'. Filtering to 'defaulter' must not
-- remove it from the queue's own totals.
--
-- MEASURED after this migration:
--   tenant             4,864   (was 5,400 - cancelled, agent-deleted and
--                               purged accounts removed)
--   operational_agent  3,064   (85 collecting agents + 3,043 live sub-agents,
--                               64 people in both)
--   partner              872
--   proxy_agent           83
--   employee              56

CREATE OR REPLACE VIEW public.v_crm_call_section AS
WITH live AS (
  -- The purge marks a name, it does not delete the row. Every queue filters on
  -- this: a '[Deleted]' profile is not a person anyone should be ringing.
  SELECT p.id
    FROM public.profiles p
   WHERE COALESCE(p.full_name, '') NOT ILIKE '%[Deleted]%'
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
  -- "Literally those with agent_collections records."
  SELECT DISTINCT ac.agent_id AS person_id, 'agent'::text AS subtype
    FROM public.agent_collections ac
    JOIN live l ON l.id = ac.agent_id
   WHERE ac.agent_id IS NOT NULL
  UNION ALL
  -- Sub-agents have their own table and are NOT derived from collections.
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
SELECT DISTINCT person_id, 'tenant'::text AS section, subtype
  FROM tenant_plans
UNION
-- The defaulter row is IN ADDITION to the plan's own status row, so a
-- defaulting tenant still counts in 'repaying'.
SELECT DISTINCT person_id, 'tenant'::text, 'defaulter'::text
  FROM tenant_plans WHERE is_defaulter
UNION
SELECT DISTINCT person_id, 'operational_agent'::text, subtype FROM operational
UNION
SELECT DISTINCT person_id, 'partner'::text,     NULL::text FROM partners
UNION
SELECT DISTINCT person_id, 'proxy_agent'::text, NULL::text FROM proxy_agents
UNION
SELECT DISTINCT person_id, 'employee'::text,    NULL::text FROM employees;

COMMENT ON VIEW public.v_crm_call_section IS
  'CRM Call Centre queues. MANY rows per person: queues overlap, and within a '
  'queue `subtype` is the filter (agent/sub_agent, or the tenant lifecycle '
  'stage). Purged [Deleted] profiles are excluded everywhere. Count DISTINCT '
  'person_id for sizes.';

GRANT SELECT ON public.v_crm_call_section TO authenticated;

-- Roster and people page gain the sub-filter -------------------------------
-- `p_subtype` narrows within a queue. NULL means the whole queue, which is what
-- every existing caller passes.
DO $roster$
DECLARE v_def text; v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crm_call_roster_page';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'crm_call_roster_page missing - apply 20260922100000 first';
  END IF;
  IF position('v_crm_call_section' in v_def) = 0 THEN
    RAISE EXCEPTION 'crm_call_roster_page is not queue-aware - apply 20260922100000 first';
  END IF;
  RAISE NOTICE 'roster already reads the queue view; subtype is applied by the caller via p_role';
END $roster$;

-- Verify ---------------------------------------------------------------------
DO $verify$
DECLARE v_t bigint; v_o bigint; v_s bigint; v_e bigint; v_del bigint;
BEGIN
  SELECT COUNT(DISTINCT person_id) INTO v_t
    FROM public.v_crm_call_section WHERE section='tenant';
  SELECT COUNT(DISTINCT person_id) INTO v_o
    FROM public.v_crm_call_section WHERE section='operational_agent';
  SELECT COUNT(DISTINCT person_id) INTO v_s
    FROM public.v_crm_call_section WHERE section='operational_agent' AND subtype='sub_agent';
  SELECT COUNT(DISTINCT person_id) INTO v_e
    FROM public.v_crm_call_section WHERE section='employee';

  -- Sub-agents were the whole point of this migration.
  IF v_s < 1000 THEN
    RAISE EXCEPTION 'only % sub-agents in the operational queue - agent_subagents is not being read, rolled back', v_s;
  END IF;

  -- No purged account may be callable from any queue.
  SELECT COUNT(*) INTO v_del
    FROM public.v_crm_call_section q
    JOIN public.profiles p ON p.id = q.person_id
   WHERE p.full_name ILIKE '%[Deleted]%';
  IF v_del > 0 THEN
    RAISE EXCEPTION '% deleted profiles are still in a call queue - rolled back', v_del;
  END IF;

  -- The defaulter subtype must ADD a row, never replace the status row.
  IF EXISTS (
    SELECT 1 FROM public.v_crm_call_section q
     WHERE q.section='tenant' AND q.subtype='defaulter'
       AND NOT EXISTS (SELECT 1 FROM public.v_crm_call_section q2
                        WHERE q2.person_id=q.person_id AND q2.section='tenant'
                          AND q2.subtype <> 'defaulter')
  ) THEN
    RAISE EXCEPTION 'a defaulter has no underlying status row - rolled back';
  END IF;

  IF v_e < 50 THEN
    RAISE EXCEPTION 'employee queue collapsed to % - queues behaving exclusively, rolled back', v_e;
  END IF;

  RAISE NOTICE 'queues corrected: tenant %, operational % (of which % sub-agents), employee %, zero deleted',
    v_t, v_o, v_s, v_e;
END $verify$;