-- Speed up get_agent_active_breakdown by counting each day once.
--
-- The live daily CTE asks count(DISTINCT uid) twice for every day of
-- generate_series, and each ask scans the agents or subs CTE again.
-- On a 365-day range that is 366 passes over each CTE. EXPLAIN
-- (ANALYZE, BUFFERS) of the inlined live body, read-only on
-- byrzshwlentqvktcksem, 2026-11-04, UTC, shared_read = 0:
--   7d    10,968.4 ms   max loops 3,497   (timing overhead; see below)
--   30d      281.3 ms   max loops 31
--   90d      980.6 ms   max loops 91
--   365d   4,696.7 ms   max loops 366
-- On the 365-day plan, InitPlan 18 (the correlated daily aggregate)
-- was 4,513.2 ms of the 4,696.7 ms.
--
-- The same statement with a_day / s_day (one GROUP BY per side, LEFT
-- JOIN onto days, COALESCE to 0) and the two NOT IN (sub_ids) predicates
-- rewritten as NOT EXISTS:
--   7d    11,365.3 ms   max loops 3,497
--   30d      150.0 ms   max loops 1
--   90d      193.1 ms   max loops 1
--   365d     205.4 ms   max loops 1
-- shared_read stayed 0. The 7-day EXPLAIN time is the instrumentation
-- of a nested-loop semi-join already present in subs (3,498 loops over
-- the sub-agent id CTE). An uninstrumented run of these same bodies in
-- that session finished the 7-day range in about 90 ms before and 75 ms
-- after. The rewritten body was 48 / 84 / 90 ms at 30 / 90 / 365 days.
--
-- jsonb text of the old and new bodies matched for 7, 30, 90 and 365
-- days (trend lengths 8, 31, 91, 366). sub_ids cannot contain NULL:
-- links keeps only rows with both ids, and agent_subagents itself has
-- no NULL sub_agent_id or parent_agent_id (0 of 32,549). NOT EXISTS
-- therefore matches NOT IN. A NULL in sub_ids would have made NOT IN
-- drop every direct agent; NOT EXISTS does not.
--
-- Signature, RETURNS jsonb, LANGUAGE plpgsql, STABLE, SECURITY DEFINER,
-- search_path and the auth/role gate stay as they are. CREATE OR REPLACE
-- keeps the current ACL. The statements below re-state it:
--   proacl = {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   anon and PUBLIC have no EXECUTE.
-- Refuses to replace the function unless prosrc md5 is still the body
-- measured above (4a0c137e9c3a74fbae53a749f3b85fcd). Not applied to
-- production by this change.
-- Version 20261104090000 sorts after 20261103181238.

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public.get_agent_active_breakdown(timestamp with time zone, timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.get_agent_active_breakdown(timestamp with time zone, timestamp with time zone) does not exist';
  END IF;
  SELECT md5(prosrc) INTO v_md5
  FROM pg_proc
  WHERE oid = 'public.get_agent_active_breakdown(timestamp with time zone, timestamp with time zone)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '4a0c137e9c3a74fbae53a749f3b85fcd' THEN
    RAISE EXCEPTION 'precondition failed: get_agent_active_breakdown prosrc md5 is %, expected 4a0c137e9c3a74fbae53a749f3b85fcd', v_md5;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.get_agent_active_breakdown(p_range_start timestamp with time zone, p_range_end timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_prev_start timestamptz;
  v_prev_end timestamptz := p_range_start;
  v_span interval;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cto')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_span := p_range_end - p_range_start;
  v_prev_start := p_range_start - v_span;

  WITH links AS (
    SELECT DISTINCT sub_agent_id, parent_agent_id
      FROM agent_subagents
     WHERE sub_agent_id IS NOT NULL AND parent_agent_id IS NOT NULL
  ),
  sub_ids AS (SELECT DISTINCT sub_agent_id FROM links),
  coll AS (
    SELECT ac.agent_id AS uid,
           (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           ac.created_at
      FROM agent_collections ac
     WHERE ac.agent_id IS NOT NULL
       AND ac.reversed_at IS NULL
       AND ac.created_at >= v_prev_start
       AND ac.created_at < p_range_end
  ),
  w AS (
    SELECT uid, day,
           (created_at >= p_range_start AND created_at < p_range_end) AS is_curr,
           (created_at >= v_prev_start AND created_at < v_prev_end) AS is_prev
      FROM coll
  ),
  subs AS (
    SELECT w.uid, w.day, w.is_curr, w.is_prev
      FROM w WHERE w.uid IN (SELECT sub_agent_id FROM sub_ids)
  ),
  direct AS (
    SELECT w.uid, w.day, w.is_curr, w.is_prev
      FROM w WHERE NOT EXISTS (SELECT 1 FROM sub_ids si WHERE si.sub_agent_id = w.uid)
  ),
  via_team AS (
    SELECT l.parent_agent_id AS uid, s.day, s.is_curr, s.is_prev
      FROM subs s
      JOIN links l ON l.sub_agent_id = s.uid
     WHERE NOT EXISTS (SELECT 1 FROM sub_ids si WHERE si.sub_agent_id = l.parent_agent_id)
  ),
  agents AS (
    SELECT * FROM direct
    UNION ALL
    SELECT * FROM via_team
  ),
  days AS (
    SELECT generate_series(
             date_trunc('day', p_range_start),
             date_trunc('day', p_range_end - interval '1 second'),
             interval '1 day'
           ) AS ts
  ),
  a_day AS (SELECT day, count(DISTINCT uid) n FROM agents WHERE is_curr GROUP BY day),
  s_day AS (SELECT day, count(DISTINCT uid) n FROM subs WHERE is_curr GROUP BY day),
  daily AS (
    SELECT d.ts, COALESCE(ad.n, 0) AS agents, COALESCE(sd.n, 0) AS subagents
      FROM days d
      LEFT JOIN a_day ad ON ad.day = (d.ts AT TIME ZONE 'Africa/Kampala')::date
      LEFT JOIN s_day sd ON sd.day = (d.ts AT TIME ZONE 'Africa/Kampala')::date
  )
  SELECT jsonb_build_object(
    'agents_curr',    (SELECT count(DISTINCT uid) FROM agents WHERE is_curr),
    'agents_prev',    (SELECT count(DISTINCT uid) FROM agents WHERE is_prev),
    'subagents_curr', (SELECT count(DISTINCT uid) FROM subs WHERE is_curr),
    'subagents_prev', (SELECT count(DISTINCT uid) FROM subs WHERE is_prev),
    'total_curr',     (SELECT count(DISTINCT uid) FROM agents WHERE is_curr)
                      + (SELECT count(DISTINCT uid) FROM subs WHERE is_curr),
    'total_prev',     (SELECT count(DISTINCT uid) FROM agents WHERE is_prev)
                      + (SELECT count(DISTINCT uid) FROM subs WHERE is_prev),
    'trend',          COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'day', ts, 'agents', agents, 'subagents', subagents
                       ) ORDER BY ts) FROM daily), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_agent_active_breakdown(timestamp with time zone, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_agent_active_breakdown(timestamp with time zone, timestamp with time zone) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_agent_active_breakdown(timestamp with time zone, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_active_breakdown(timestamp with time zone, timestamp with time zone) TO service_role;
