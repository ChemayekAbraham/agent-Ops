-- Speed up public.landlord_hub_list, the Landlord Calling Hub page.
--
-- The live function (copied from pg_get_functiondef on 2026-11-05; signature,
-- SECURITY DEFINER, search_path and grants are unchanged) filters
-- mv_landlord_hub_registry with a chain of OR'd plpgsql parameters
-- (`$scope IN ('live','live_plans') AND plan_stage = 'live' OR ...`).
-- PL/pgSQL caches a generic plan for that text, so the planner cannot see
-- which branch is true. EXPLAIN (ANALYZE, BUFFERS) of that generic plan for
-- the app's default call (live / to_call / rent_plan_value / limit 50) was a
-- parallel seq scan of all ~47k registry rows plus a hash join, 35.4 ms when
-- the buffers were already hot. A half-literal version that still left the
-- tab and search guards as parameters nested-looped each live row against the
-- latest-call CTE (~646k probes, 332 ms). Inlining only the predicates that
-- are actually in use lets the generic plan use
-- mv_landlord_hub_registry_plan_stage_sort_idx and a hash join: 6.2 ms for
-- the same default call, 5.1 ms for a live search.
--
-- Row shape, auth, scope/tab rules, sort, total_count and phone masking are
-- the same. Read-only parity against the live function (same transaction
-- snapshot, same staff session): default page 50 rows, total 224, identical
-- JSON in the same order; search "wakiso" 14 rows, total 14, identical JSON.
-- No materialized view change. Not applied to the live database by this file's
-- author.
--
-- Version 20261105160000. Free on origin/lovable (latest file there is
-- 20261105150000) and in schema_migrations (latest live version at write time
-- 20261105130318). 20261105140000 was also free, but 20261105150000 is already
-- on lovable, so this file stays after it.

CREATE OR REPLACE FUNCTION public.landlord_hub_list(
  p_scope text DEFAULT 'live'::text,
  p_tab text DEFAULT 'to_call'::text,
  p_search text DEFAULT NULL::text,
  p_region text DEFAULT NULL::text,
  p_district text DEFAULT NULL::text,
  p_agent text DEFAULT NULL::text,
  p_verified text DEFAULT NULL::text,
  p_sort text DEFAULT 'rent_plan_value'::text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_status text DEFAULT NULL::text,
  p_stage text DEFAULT NULL::text
)
RETURNS TABLE(
  landlord_key text,
  landlord_id uuid,
  user_id uuid,
  landlord_name text,
  phone text,
  phone_masked boolean,
  region text,
  district text,
  agent_id uuid,
  agent_name text,
  verified boolean,
  verification_status text,
  houses_count integer,
  live_rent_plans integer,
  rent_plan_value numeric,
  last_call_at timestamp with time zone,
  last_result text,
  last_caller_id uuid,
  last_caller_name text,
  call_back_due_at timestamp with time zone,
  call_back_overdue boolean,
  being_called_by_id uuid,
  being_called_by text,
  being_called_since timestamp with time zone,
  hub_status text,
  needs_review boolean,
  total_count bigint,
  plan_stage text,
  plans_total integer,
  tenants_count integer,
  check_flags text[],
  needs_check boolean,
  registrar_is_agent_now boolean,
  service_center_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_scope     text := lower(btrim(COALESCE(NULLIF(p_scope, ''), 'live')));
  v_tab       text := lower(btrim(COALESCE(NULLIF(p_tab, ''), 'to_call')));
  v_search    text := lower(btrim(COALESCE(p_search, '')));
  v_region    text := NULLIF(btrim(COALESCE(p_region, '')), '');
  v_district  text := NULLIF(btrim(COALESCE(p_district, '')), '');
  v_agent     text := NULLIF(btrim(COALESCE(p_agent, '')), '');
  v_verified  text := lower(btrim(COALESCE(p_verified, '')));
  v_status    text := lower(btrim(COALESCE(p_status, '')));
  v_stage     text := lower(btrim(COALESCE(p_stage, '')));
  v_sort      text := lower(btrim(COALESCE(NULLIF(p_sort, ''), 'rent_plan_value')));
  v_limit     integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_offset    integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_unmasked  boolean;
  v_now       timestamptz := now();
  v_filters   text;
  v_tab_sql   text;
  v_order     text;
  v_sql       text;
BEGIN
  IF NOT public._landlord_hub_can_read() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: you are not authorised to view the Landlord Calling Hub'
      USING ERRCODE = '42501';
  END IF;

  IF v_scope NOT IN ('live', 'live_plans', 'in_progress', 'finished', 'registered_only', 'check_first', 'with_plans', 'all') THEN
    RAISE EXCEPTION 'SCOPE_INVALID: p_scope must be live, in_progress, finished, registered_only, check_first, with_plans or all'
      USING ERRCODE = '22023';
  END IF;

  IF v_tab NOT IN ('to_call', 'call_back', 'answered', 'not_answered', 'all') THEN
    RAISE EXCEPTION 'TAB_INVALID: p_tab must be to_call, call_back, answered, not_answered or all'
      USING ERRCODE = '22023';
  END IF;

  IF v_status NOT IN ('', 'all', 'pending', 'verified', 'rejected', 'unverified') THEN
    RAISE EXCEPTION 'STATUS_INVALID: p_status must be pending, verified, rejected, unverified or all'
      USING ERRCODE = '22023';
  END IF;

  IF v_stage NOT IN ('', 'all', 'live', 'in_progress', 'finished', 'registered_only') THEN
    RAISE EXCEPTION 'STAGE_INVALID: p_stage must be live, in_progress, finished, registered_only or all'
      USING ERRCODE = '22023';
  END IF;

  v_unmasked := public._landlord_cc_can_view_unmasked_phone();

  -- Closed sets are written as literals so the cached plan matches this call.
  -- Free-text filters are quote_literal'd (still constants to the planner,
  -- never raw interpolation). $1 is v_now and $2 is v_unmasked.
  v_filters := CASE v_scope
    WHEN 'live' THEN 'reg.plan_stage = ''live'''
    WHEN 'live_plans' THEN 'reg.plan_stage = ''live'''
    WHEN 'in_progress' THEN 'reg.plan_stage = ''in_progress'''
    WHEN 'finished' THEN 'reg.plan_stage = ''finished'''
    WHEN 'registered_only' THEN 'reg.plan_stage = ''registered_only'''
    WHEN 'check_first' THEN 'reg.needs_check IS TRUE'
    WHEN 'with_plans' THEN 'reg.plans_total > 0'
    ELSE 'TRUE'
  END;

  IF v_stage IN ('live', 'in_progress', 'finished', 'registered_only') THEN
    v_filters := v_filters || ' AND reg.plan_stage = ' || quote_literal(v_stage);
  END IF;

  IF v_status = 'unverified' THEN
    v_filters := v_filters || ' AND reg.verification_status <> ''verified''';
  ELSIF v_status IN ('pending', 'verified', 'rejected') THEN
    v_filters := v_filters || ' AND reg.verification_status = ' || quote_literal(v_status);
  END IF;

  IF v_verified IN ('true', 'verified', 'yes', '1') THEN
    v_filters := v_filters || ' AND reg.verification_status = ''verified''';
  ELSIF v_verified IN ('false', 'unverified', 'no', '0') THEN
    v_filters := v_filters || ' AND reg.verification_status <> ''verified''';
  ELSIF v_verified IN ('pending', 'rejected') THEN
    v_filters := v_filters || ' AND reg.verification_status = ' || quote_literal(v_verified);
  END IF;

  IF v_region IS NOT NULL THEN
    v_filters := v_filters || ' AND lower(COALESCE(reg.region, '''')) = lower(' || quote_literal(v_region) || ')';
  END IF;

  IF v_district IS NOT NULL THEN
    v_filters := v_filters || ' AND lower(COALESCE(reg.district, '''')) = lower(' || quote_literal(v_district) || ')';
  END IF;

  IF v_agent IS NOT NULL THEN
    v_filters := v_filters || ' AND (reg.registering_agent_id::text = ' || quote_literal(v_agent)
      || ' OR lower(COALESCE(reg.registering_agent_name, '''')) = lower(' || quote_literal(v_agent) || '))';
  END IF;

  IF v_search <> '' THEN
    v_filters := v_filters || ' AND ('
      || 'strpos(lower(COALESCE(reg.full_name, '''')), ' || quote_literal(v_search) || ') > 0 OR '
      || 'strpos(lower(COALESCE(reg.phones[1], '''')), ' || quote_literal(v_search) || ') > 0 OR '
      || 'strpos(lower(COALESCE(reg.district, '''')), ' || quote_literal(v_search) || ') > 0 OR '
      || 'strpos(lower(COALESCE(reg.registering_agent_name, '''')), ' || quote_literal(v_search) || ') > 0)';
  END IF;

  v_tab_sql := CASE v_tab
    WHEN 'all' THEN 'TRUE'
    WHEN 'call_back' THEN 'c.status_bucket = ''call_back'''
    WHEN 'answered' THEN 'c.status_bucket = ''answered'''
    WHEN 'not_answered' THEN 'c.status_bucket = ''not_answered'''
    ELSE
      'c.verification_status <> ''rejected'' AND NOT c.is_frozen AND '
      || CASE WHEN v_scope = 'check_first' THEN 'TRUE' ELSE 'NOT c.needs_check' END
      || ' AND (c.status_bucket = ''never_called'' OR (c.status_bucket = ''not_answered'' AND c.eff_last_call_at < ($1 - interval ''7 days'')))'
  END;

  -- Prefix keys are NULL for every row when that sort is not selected, so
  -- emitting only the live prefix matches the previous ORDER BY.
  v_order := CASE
    WHEN v_sort IN ('call_back_due', 'callback_due') THEN 'f.eff_call_back_due_at ASC NULLS LAST, '
    WHEN v_sort IN ('last_called', 'last_called_at', 'oldest_call_first') THEN 'f.eff_last_call_at ASC NULLS FIRST, '
    WHEN v_sort IN ('newest_registration', 'registered_at') THEN 'f.registered_at DESC NULLS LAST, '
    WHEN v_sort IN ('name', 'landlord_name') THEN 'lower(f.landlord_name) ASC NULLS LAST, '
    WHEN v_tab = 'to_call' AND v_sort = 'rent_plan_value' THEN
      'CASE WHEN f.plan_stage = ''in_progress'' AND f.eff_last_call_at IS NULL THEN 0 '
      || 'WHEN f.plan_stage = ''live'' AND f.eff_last_call_at IS NULL THEN 1 ELSE 2 END ASC NULLS LAST, '
    ELSE ''
  END;
  v_order := v_order
    || 'CASE WHEN ''plan_overload'' = ANY(f.check_flags) THEN -1::numeric ELSE f.rent_plan_value END DESC NULLS LAST, '
    || 'f.eff_last_call_at ASC NULLS FIRST, f.live_rent_plans DESC NULLS LAST, f.l_key ASC';

  v_sql := $q$
WITH hub_latest AS MATERIALIZED (
  SELECT DISTINCT ON (c.landlord_key)
    c.landlord_key,
    c.id AS call_id,
    c.recorded_at,
    c.result,
    c.call_back_at,
    c.caller_id,
    COALESCE(NULLIF(btrim(cp.full_name), ''), 'Landlord Ops officer') AS caller_name
  FROM public.v_landlord_calls_effective c
  LEFT JOIN public.profiles cp ON cp.id = c.caller_id
  WHERE c.voided_at IS NULL
  ORDER BY c.landlord_key, c.recorded_at DESC, c.id DESC
),
active_dials AS MATERIALIZED (
  SELECT DISTINCT ON (d.landlord_key)
    d.landlord_key,
    d.caller_id,
    COALESCE(NULLIF(btrim(dp.full_name), ''), 'Landlord Ops officer') AS caller_name,
    d.started_at
  FROM public.landlord_call_dials d
  LEFT JOIN public.profiles dp ON dp.id = d.caller_id
  WHERE d.call_id IS NULL
    AND d.expires_at > $1
  ORDER BY d.landlord_key, d.started_at DESC
),
scoped_reg AS (
  SELECT
    reg.landlord_key_text AS l_key,
    reg.landlord_id,
    reg.user_id,
    COALESCE(NULLIF(btrim(reg.full_name), ''), 'Unnamed Landlord') AS landlord_name,
    reg.phones[1] AS primary_phone,
    reg.region,
    reg.district,
    reg.registering_agent_id AS agent_id,
    reg.registering_agent_name AS agent_name,
    (reg.verification_status = 'verified') AS is_verified,
    reg.verification_status,
    COALESCE(reg.is_flagged, false) AS is_frozen,
    COALESCE(reg.houses_count, 0)::integer AS houses_count,
    COALESCE(reg.plans_live, 0)::integer AS live_rent_plans,
    COALESCE(reg.plan_rent_total, 0)::numeric AS rent_plan_value,
    reg.needs_review,
    reg.registered_at,
    reg.plan_stage,
    COALESCE(reg.plans_total, 0)::integer AS plans_total,
    COALESCE(reg.tenants_count, 0)::integer AS tenants_count,
    COALESCE(reg.check_flags, ARRAY[]::text[]) AS check_flags,
    COALESCE(reg.needs_check, false) AS needs_check,
    COALESCE(reg.registrar_is_agent_now, false) AS registrar_is_agent_now,
    COALESCE(reg.service_center_status, 'not_required') AS service_center_status,
    CASE
      WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
        THEN hl.recorded_at
      ELSE reg.last_called_at
    END AS eff_last_call_at,
    CASE
      WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
        THEN hl.result
      ELSE reg.last_call_outcome
    END AS eff_last_result,
    CASE
      WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
        THEN hl.caller_id
      ELSE NULL::uuid
    END AS eff_last_caller_id,
    CASE
      WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
        THEN hl.caller_name
      ELSE reg.last_caller_name
    END AS eff_last_caller_name,
    CASE
      WHEN hl.result = 'call_back'
           AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
        THEN hl.call_back_at
      ELSE NULL::timestamptz
    END AS eff_call_back_due_at,
    ad.caller_id AS dial_caller_id,
    ad.caller_name AS dial_caller_name,
    ad.started_at AS dial_started_at
  FROM public.mv_landlord_hub_registry reg
  LEFT JOIN hub_latest hl ON hl.landlord_key = reg.landlord_key_text
  LEFT JOIN active_dials ad ON ad.landlord_key = reg.landlord_key_text
  WHERE $q$ || v_filters || $q$
),
classified AS (
  SELECT
    s.*,
    CASE
      WHEN s.eff_last_result IN ('call_back', 'call_back_later', 'callback_booked') THEN 'call_back'
      WHEN s.eff_last_result IN (
        'answered', 'engaged', 'reached_ok', 'confirmed_payout_number',
        'wants_more_tenants', 'complaint', 'payout_issue', 'picked_up', 'called'
      ) THEN 'answered'
      WHEN s.eff_last_call_at IS NOT NULL THEN 'not_answered'
      ELSE 'never_called'
    END AS status_bucket
  FROM scoped_reg s
),
filtered AS (
  SELECT
    c.*,
    (count(*) OVER ())::bigint AS total_n
  FROM classified c
  WHERE $q$ || v_tab_sql || $q$
)
SELECT
  f.l_key AS landlord_key,
  f.landlord_id,
  f.user_id,
  f.landlord_name,
  CASE
    WHEN f.primary_phone IS NULL OR btrim(f.primary_phone) = '' THEN '—'
    WHEN $2 THEN f.primary_phone
    ELSE public.crm_mask_phone(f.primary_phone)
  END AS phone,
  (NOT $2) AS phone_masked,
  f.region,
  f.district,
  f.agent_id,
  f.agent_name,
  f.is_verified AS verified,
  f.verification_status,
  f.houses_count,
  f.live_rent_plans,
  f.rent_plan_value,
  f.eff_last_call_at AS last_call_at,
  f.eff_last_result AS last_result,
  f.eff_last_caller_id AS last_caller_id,
  f.eff_last_caller_name AS last_caller_name,
  f.eff_call_back_due_at AS call_back_due_at,
  (f.eff_call_back_due_at IS NOT NULL AND f.eff_call_back_due_at < $1) AS call_back_overdue,
  f.dial_caller_id AS being_called_by_id,
  f.dial_caller_name AS being_called_by,
  f.dial_started_at AS being_called_since,
  f.status_bucket AS hub_status,
  f.needs_review,
  f.total_n AS total_count,
  f.plan_stage,
  f.plans_total,
  f.tenants_count,
  f.check_flags,
  f.needs_check,
  f.registrar_is_agent_now,
  f.service_center_status
FROM filtered f
ORDER BY $q$ || v_order || ' LIMIT ' || v_limit::text || ' OFFSET ' || v_offset::text;

  RETURN QUERY EXECUTE v_sql USING v_now, v_unmasked;
END;
$function$;

-- CREATE OR REPLACE keeps existing grants. Re-state the live ACL
-- ({postgres=X/postgres,authenticated=X/postgres}) so a fresh database matches.
REVOKE ALL ON FUNCTION public.landlord_hub_list(text, text, text, text, text, text, text, text, integer, integer, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_hub_list(text, text, text, text, text, text, text, text, integer, integer, text, text) TO authenticated;
