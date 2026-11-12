-- cc_state_counts was averaging ~3.5s and timing out (statement timeout, HTTP 500
-- at ~8.2s) because every tally scanned v_cc_call_queue. That view left-joins
-- cc_cycle_rows to a stack of LATERAL subqueries (tenant base, landlord base,
-- agent directory, advances, float, feedback, tickets). A state count with no
-- filter and no search does not read any of those columns, but the planner
-- still evaluates them (about 3.6s and ~950k buffer hits on the open tenant cycle).
--
-- Both overloads are replaced in place. Signatures, return type, SECURITY
-- DEFINER, search_path and the cc_queue_access_allowed check stay as they are.
-- CREATE OR REPLACE keeps the existing grants (postgres, authenticated,
-- service_role). Do not DROP these functions: a drop would reset grants to the
-- closed-by-default privileges.
--
-- Live definitions this file is allowed to replace (md5 of pg_get_functiondef,
-- read 2026-11-12):
--   cc_state_counts(cc_subject_type, jsonb)       620976368d4e0b15902fdf0a5eb1f381
--   cc_state_counts(cc_subject_type, jsonb, text) f966be712cfbaad2a4734e8d3e988805
--
-- Why an unfiltered count from cc_cycle_rows is the same number:
--   v_cc_call_queue is FROM cc_cycle_rows with no WHERE, and every join is a
--   LEFT JOIN. The non-lateral joins cannot multiply a row: profiles.id is the
--   primary key, and v_landlord_call_summary is GROUP BY landlord_id. Every
--   LATERAL is LIMIT 1 or a scalar aggregate (exactly one row). state is
--   cc_cycle_rows.state. Checked on the open cycles (tenant 1285, landlord
--   2147): view rows = distinct cycle_row_id = cc_cycle_rows rows (3432), and
--   per-state counts had no differences.
--
-- Filters and search still read the view. cc_filter_predicate emits predicates
-- on view columns that are not stored on cc_cycle_rows (arrears_amount,
-- days_behind, district, region, linked_agent_name, registering_agent_name,
-- preferred_language), and search is an ILIKE on the view's name and district.
-- The screens send null filters and null search unless an officer has typed or
-- picked something (useCcCallingHub refetches that unfiltered tally every 60s;
-- the tenant workspace always passes p_filters null). That is the path that
-- was timing out.
--
-- The unfiltered query is an index-only scan of cc_cycle_rows_cycle_state_idx.
-- Measured with EXPLAIN ANALYZE on the open cycles: 1.0 ms (tenant, 72 buffer
-- hits) and 1.2 ms (landlord, 18 buffer hits).

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.cc_state_counts(cc_subject_type, jsonb)'::regprocedure))
       IS DISTINCT FROM '620976368d4e0b15902fdf0a5eb1f381' THEN
    RAISE EXCEPTION 'refusing to replace cc_state_counts(cc_subject_type, jsonb): live md5 % does not match 620976368d4e0b15902fdf0a5eb1f381',
      coalesce(md5(pg_get_functiondef('public.cc_state_counts(cc_subject_type, jsonb)'::regprocedure)), 'missing');
  END IF;
  IF md5(pg_get_functiondef('public.cc_state_counts(cc_subject_type, jsonb, text)'::regprocedure))
       IS DISTINCT FROM 'f966be712cfbaad2a4734e8d3e988805' THEN
    RAISE EXCEPTION 'refusing to replace cc_state_counts(cc_subject_type, jsonb, text): live md5 % does not match f966be712cfbaad2a4734e8d3e988805',
      coalesce(md5(pg_get_functiondef('public.cc_state_counts(cc_subject_type, jsonb, text)'::regprocedure)), 'missing');
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.cc_state_counts(p_subject_type cc_subject_type, p_filters jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(state cc_row_state, row_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cycle_id uuid;
  v_filter_sql text;
BEGIN
  IF NOT cc_queue_access_allowed(p_subject_type) THEN
    RAISE EXCEPTION 'not authorized to read the % call queue', p_subject_type;
  END IF;

  SELECT c.id INTO v_cycle_id
    FROM cc_call_cycles c
   WHERE c.subject_type = p_subject_type
     AND c.closed_at IS NULL
   ORDER BY c.opened_at DESC
   LIMIT 1;

  IF v_cycle_id IS NULL THEN
    RETURN;
  END IF;

  v_filter_sql := coalesce(cc_filter_predicate(p_subject_type, p_filters), '');

  -- No predicate: the view does not add or drop rows, so count the cycle directly.
  IF v_filter_sql = '' THEN
    RETURN QUERY
    SELECT s.s, coalesce(count(r.state), 0)::bigint
      FROM unnest(enum_range(NULL::cc_row_state)) AS s(s)
      LEFT JOIN cc_cycle_rows r
        ON r.cycle_id = v_cycle_id
       AND r.state = s.s
     GROUP BY s.s
     ORDER BY s.s;
    RETURN;
  END IF;

  RETURN QUERY EXECUTE format($f$
    WITH base AS (
      SELECT q.state
        FROM v_cc_call_queue q
       WHERE q.cycle_id = %1$L
         %2$s
    )
    SELECT s.s AS state, coalesce(count(b.state), 0)::bigint AS row_count
      FROM unnest(enum_range(NULL::cc_row_state)) AS s(s)
      LEFT JOIN base b ON b.state = s.s
     GROUP BY s.s
     ORDER BY s.s
  $f$, v_cycle_id, v_filter_sql);
END;
$function$;

CREATE OR REPLACE FUNCTION public.cc_state_counts(p_subject_type cc_subject_type, p_filters jsonb DEFAULT NULL::jsonb, p_search text DEFAULT NULL::text)
 RETURNS TABLE(state cc_row_state, row_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cycle_id uuid;
  v_filter_sql text;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
BEGIN
  IF NOT cc_queue_access_allowed(p_subject_type) THEN
    RAISE EXCEPTION 'not authorized to read the % call queue', p_subject_type;
  END IF;

  SELECT c.id INTO v_cycle_id
    FROM cc_call_cycles c
   WHERE c.subject_type = p_subject_type
     AND c.closed_at IS NULL
   ORDER BY c.opened_at DESC
   LIMIT 1;

  IF v_cycle_id IS NULL THEN
    RETURN;
  END IF;

  v_filter_sql := coalesce(cc_filter_predicate(p_subject_type, p_filters), '');

  -- No predicate and no search: same rows as cc_cycle_rows. Name and district
  -- exist only on the view, so any search stays on v_cc_call_queue below.
  IF v_filter_sql = '' AND v_search IS NULL THEN
    RETURN QUERY
    SELECT s.s, coalesce(count(r.state), 0)::bigint
      FROM unnest(enum_range(NULL::cc_row_state)) AS s(s)
      LEFT JOIN cc_cycle_rows r
        ON r.cycle_id = v_cycle_id
       AND r.state = s.s
     GROUP BY s.s
     ORDER BY s.s;
    RETURN;
  END IF;

  RETURN QUERY EXECUTE format($f$
    WITH base AS (
      SELECT q.state
        FROM v_cc_call_queue q
       WHERE q.cycle_id = %1$L
         AND (%3$L::text IS NULL
              OR q.name ILIKE '%%' || %3$L::text || '%%'
              OR q.district ILIKE '%%' || %3$L::text || '%%')
         %2$s
    )
    SELECT s.s AS state, coalesce(count(b.state), 0)::bigint AS row_count
      FROM unnest(enum_range(NULL::cc_row_state)) AS s(s)
      LEFT JOIN base b ON b.state = s.s
     GROUP BY s.s
     ORDER BY s.s
  $f$, v_cycle_id, v_filter_sql, v_search);
END;
$function$;
