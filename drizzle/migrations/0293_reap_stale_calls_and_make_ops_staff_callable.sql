-- lovable-cron-fallback-reviewed: dead call sessions must clear within minutes; nothing else closes them because the provider callback never arrives
-- Close call sessions that died silently, and make ops staff callable.
--
-- PART A — THE REAPER
--
-- 106 sessions sit with `is_active = true` and status 'initiating' or
-- 'ringing'. The average age is 5.8 DAYS and the oldest is from 1 September.
-- Nothing has ever closed them.
--
-- PART B — OPS STAFF MUST BE CALLABLE
-- Holding crm / tenant_ops / landlord_ops / agent_ops / partner_ops is what
-- actually makes someone internal staff.

-- A. Reaper -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_reap_stale_call_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $reap$
DECLARE
  v_never_placed int := 0;
  v_no_callback  int := 0;
BEGIN
  -- 1. Never reached the provider. Nothing rang; say so plainly.
  WITH dead AS (
    UPDATE public.crm_call_sessions s
       SET status         = 'failed',
           is_active      = false,
           ended_at       = COALESCE(s.ended_at, now()),
           ended_by       = COALESCE(s.ended_by, 'system_reaper'),
           hangup_cause   = COALESCE(s.hangup_cause, 'NEVER_PLACED'),
           failure_reason = COALESCE(s.failure_reason,
                              'No provider session after 3 minutes - the call was never placed. '
                              'Usually the staff browser''s WebRTC client was not registered.'),
           updated_at     = now()
     WHERE s.is_active = true
       AND s.status IN ('initiating', 'ringing')
       AND s.at_session_id IS NULL
       AND s.answered_at IS NULL
       AND COALESCE(s.duration_seconds, 0) = 0
       AND s.created_at < now() - interval '3 minutes'
    RETURNING 1)
  SELECT count(*) INTO v_never_placed FROM dead;

  -- 2. Reached the provider, then silence. The callback never closed it out.
  WITH dead AS (
    UPDATE public.crm_call_sessions s
       SET status         = 'not_answered',
           is_active      = false,
           ended_at       = COALESCE(s.ended_at, now()),
           ended_by       = COALESCE(s.ended_by, 'system_reaper'),
           hangup_cause   = COALESCE(s.hangup_cause, 'NO_CALLBACK'),
           failure_reason = COALESCE(s.failure_reason,
                              'Provider accepted the call but never reported an outcome within 15 minutes.'),
           updated_at     = now()
     WHERE s.is_active = true
       AND s.status IN ('initiating', 'ringing')
       AND s.at_session_id IS NOT NULL
       AND s.answered_at IS NULL
       AND COALESCE(s.duration_seconds, 0) = 0
       AND s.created_at < now() - interval '15 minutes'
    RETURNING 1)
  SELECT count(*) INTO v_no_callback FROM dead;

  RETURN jsonb_build_object(
    'never_placed', v_never_placed,
    'no_callback',  v_no_callback,
    'ran_at',       now());
END $reap$;

COMMENT ON FUNCTION public.crm_reap_stale_call_sessions() IS
  'Closes call sessions the provider never resolved, so the UI stops showing a '
  'call as ongoing for days. Never touches a session that was answered or has '
  'talk time, and never rewrites an existing hangup cause.';

REVOKE ALL ON FUNCTION public.crm_reap_stale_call_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crm_reap_stale_call_sessions() TO service_role;

SELECT cron.unschedule('crm-reap-stale-call-sessions')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crm-reap-stale-call-sessions');

SELECT cron.schedule(
  'crm-reap-stale-call-sessions',
  '2-59/5 * * * *',
  $$ SELECT public.crm_reap_stale_call_sessions(); $$
);

-- B. Ops staff join the Employees queue ----------------------------------------
DO $emp$
DECLARE v_def text;
BEGIN
  SELECT pg_get_viewdef('public.v_crm_call_section'::regclass, true) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'v_crm_call_section missing - apply 20260922100000 and 20260922110000 first';
  END IF;
  IF position('staff_profiles' in v_def) = 0 THEN
    RAISE EXCEPTION 'employees CTE not found in v_crm_call_section - inspect by hand';
  END IF;
END $emp$;

CREATE OR REPLACE VIEW public.v_crm_call_section AS
WITH live AS (
  SELECT p.id FROM public.profiles p
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
  SELECT DISTINCT ac.agent_id AS person_id, 'agent'::text AS subtype
    FROM public.agent_collections ac
    JOIN live l ON l.id = ac.agent_id
   WHERE ac.agent_id IS NOT NULL
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
      -- Holding an ops desk IS being staff, whether or not HR has a row.
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

-- One immediate sweep so the sessions stuck since 1 September clear now.
SELECT public.crm_reap_stale_call_sessions();

-- Verify ------------------------------------------------------------------------
DO $verify$
DECLARE v_stuck int; v_emp bigint; v_missing int; v_job int;
BEGIN
  SELECT count(*) INTO v_stuck FROM public.crm_call_sessions
   WHERE is_active = true AND status IN ('initiating','ringing')
     AND answered_at IS NULL AND COALESCE(duration_seconds,0) = 0
     AND created_at < now() - interval '15 minutes';
  IF v_stuck > 0 THEN
    RAISE EXCEPTION 'reaper left % stale sessions active - rolled back', v_stuck;
  END IF;

  IF EXISTS (SELECT 1 FROM public.crm_call_sessions
              WHERE ended_by = 'system_reaper'
                AND (answered_at IS NOT NULL OR COALESCE(duration_seconds,0) > 0)) THEN
    RAISE EXCEPTION 'reaper touched a call that had connected - rolled back';
  END IF;

  SELECT count(*) INTO v_job FROM cron.job WHERE jobname = 'crm-reap-stale-call-sessions' AND active;
  IF v_job <> 1 THEN RAISE EXCEPTION 'reaper is not scheduled - rolled back'; END IF;

  SELECT count(*) INTO v_missing
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
   WHERE ur.enabled = true
     AND ur.role::text IN ('crm','tenant_ops','landlord_ops','agent_ops','partner_ops')
     AND COALESCE(p.full_name,'') NOT ILIKE '%[Deleted]%'
     AND NOT EXISTS (SELECT 1 FROM public.v_crm_call_section q
                      WHERE q.person_id = ur.user_id AND q.section = 'employee');
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% ops staff are still not callable - rolled back', v_missing;
  END IF;

  SELECT count(DISTINCT person_id) INTO v_emp
    FROM public.v_crm_call_section WHERE section = 'employee';
  RAISE NOTICE 'reaper scheduled, no stale sessions left, employees queue now %', v_emp;
END $verify$;