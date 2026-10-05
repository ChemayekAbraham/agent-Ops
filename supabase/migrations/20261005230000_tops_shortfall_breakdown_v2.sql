-- v2: identical to tops_shortfall_breakdown except it reads tops_shortfall_lines_v2, so the
-- age columns (days_behind, oldest_unpaid_due, ageing buckets) are filled for plans with no
-- instalment schedule. Signature, role check, result columns and every money figure are
-- the same; the original function is untouched.
--
-- tops_shortfall_breakdown_v2: groups the per-plan lines from tops_shortfall_lines by
-- tenant / agent / service centre / area / ageing. Read-only, additive: one new
-- function, nothing existing is altered.
--
-- It is built ONLY on public.tops_shortfall_lines — expected, collected and short
-- are summed from its rows, never re-derived — so for every p_group
-- SUM(short_ugx) equals SUM(short_ugx) of tops_shortfall_lines for the same window.
--
-- Every column reference is alias-qualified: the RETURNS TABLE output names are also
-- PL/pgSQL variables and an unqualified reference raises "column reference is ambiguous".

CREATE OR REPLACE FUNCTION public.tops_shortfall_breakdown_v2(
  p_start timestamptz,
  p_end timestamptz,
  p_group text,
  p_area_level text DEFAULT 'district'
)
RETURNS TABLE (
  group_key text,
  group_name text,
  parent_name text,
  plan_count int,
  tenant_count int,
  expected_ugx numeric,
  collected_ugx numeric,
  short_ugx numeric,
  short_pct numeric,
  avg_days_behind numeric,
  max_days_behind int,
  oldest_unpaid_due date
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_group IS NULL OR p_group NOT IN ('tenant', 'agent', 'service_centre', 'area', 'ageing') THEN
    RAISE EXCEPTION 'invalid group: %, expected tenant/agent/service_centre/area/ageing', p_group;
  END IF;

  IF p_group = 'area' AND (p_area_level IS NULL OR p_area_level NOT IN ('region', 'district', 'county', 'subcounty', 'parish', 'village')) THEN
    RAISE EXCEPTION 'invalid level: %, expected region/district/county/subcounty/parish/village', p_area_level;
  END IF;

  RETURN QUERY
  WITH l AS (
    SELECT * FROM public.tops_shortfall_lines_v2(p_start, p_end)
  ),
  -- An agent could be active at more than one centre (the unique index is per
  -- centre+agent); take the latest active assignment so no line is counted twice.
  agent_centre AS (
    SELECT DISTINCT ON (a.agent_id) a.agent_id AS ag_id, a.service_centre_id AS sc_id
    FROM public.service_centre_agent_assignments a
    WHERE a.status = 'active'
    ORDER BY a.agent_id, a.assigned_at DESC, a.id
  ),
  keyed AS (
    SELECT
      CASE p_group
        WHEN 'tenant' THEN l.tenant_id::text
        WHEN 'agent' THEN l.agent_id::text
        WHEN 'service_centre' THEN COALESCE(sc.id::text, 'none')
        WHEN 'area' THEN COALESCE(ar.k_raw, 'unmapped')
        WHEN 'ageing' THEN
          CASE
            WHEN l.days_behind IS NULL THEN 'not_scheduled'
            WHEN l.days_behind <= 0 THEN 'due_today'
            WHEN l.days_behind <= 3 THEN '1-3'
            WHEN l.days_behind <= 7 THEN '4-7'
            WHEN l.days_behind <= 14 THEN '8-14'
            WHEN l.days_behind <= 30 THEN '15-30'
            ELSE '31+'
          END
      END AS gk,
      CASE p_group
        WHEN 'tenant' THEN COALESCE(NULLIF(trim(tp.full_name), ''), 'Unnamed tenant')
        WHEN 'agent' THEN COALESCE(NULLIF(trim(ap.full_name), ''), 'Unnamed agent')
        WHEN 'service_centre' THEN
          CASE WHEN sc.id IS NULL THEN 'No service centre'
               ELSE COALESCE(NULLIF(trim(sc.location_name), ''), sc.agent_name) END
        WHEN 'area' THEN COALESCE(ar.n_raw, 'Unmapped')
        WHEN 'ageing' THEN
          CASE
            WHEN l.days_behind IS NULL THEN 'Not scheduled'
            WHEN l.days_behind <= 0 THEN 'Due today'
            WHEN l.days_behind <= 3 THEN '1-3 days'
            WHEN l.days_behind <= 7 THEN '4-7 days'
            WHEN l.days_behind <= 14 THEN '8-14 days'
            WHEN l.days_behind <= 30 THEN '15-30 days'
            ELSE '31+ days'
          END
      END AS gn,
      CASE p_group
        WHEN 'tenant' THEN tp.phone
        WHEN 'area' THEN CASE WHEN p_area_level = 'region' OR ar.k_raw IS NULL THEN NULL ELSE tb.region END
        ELSE NULL
      END AS pn,
      l.rent_request_id AS rr_id,
      l.tenant_id AS tn_id,
      l.expected_ugx AS exp_ugx,
      l.collected_capped_ugx AS col_ugx,
      l.short_ugx AS sh_ugx,
      l.days_behind AS dbh,
      l.oldest_unpaid_due AS oud
    FROM l
    LEFT JOIN public.profiles tp ON tp.id = l.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = l.agent_id
    LEFT JOIN agent_centre ac ON ac.ag_id = l.agent_id
    LEFT JOIN public.service_centre_setups sc ON sc.id = ac.sc_id
    LEFT JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = l.tenant_id
    -- Same key/name CASE as tops_area_book. Unmapped tenants (no tb row, or a null id)
    -- get a NULL key here and become ONE 'unmapped' group with no parent.
    LEFT JOIN LATERAL (
      SELECT
        CASE p_area_level
          WHEN 'region' THEN tb.region
          WHEN 'district' THEN tb.district_id::text
          WHEN 'county' THEN tb.county_id::text
          WHEN 'subcounty' THEN tb.subcounty_id::text
          WHEN 'parish' THEN tb.parish_id::text
          WHEN 'village' THEN tb.village_id::text
        END AS k_raw,
        CASE p_area_level
          WHEN 'region' THEN tb.region
          WHEN 'district' THEN tb.district_name
          WHEN 'county' THEN tb.county_name
          WHEN 'subcounty' THEN tb.subcounty_name
          WHEN 'parish' THEN tb.parish_name
          WHEN 'village' THEN tb.village_name
        END AS n_raw
    ) ar ON true
  )
  SELECT
    k.gk,
    min(k.gn),
    min(k.pn),
    count(DISTINCT k.rr_id)::int,
    count(DISTINCT k.tn_id)::int,
    sum(k.exp_ugx),
    sum(k.col_ugx),
    sum(k.sh_ugx),
    round(sum(k.sh_ugx) / NULLIF(sum(k.exp_ugx), 0) * 100, 2),
    round(avg(k.dbh)::numeric, 1),
    max(k.dbh),
    min(k.oud)
  FROM keyed k
  GROUP BY k.gk
  ORDER BY sum(k.sh_ugx) DESC, k.gk;
END;
$function$;

-- This schema's default privileges auto-grant new functions to anon; revoke explicitly.
REVOKE ALL ON FUNCTION public.tops_shortfall_breakdown_v2(timestamptz, timestamptz, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_shortfall_breakdown_v2(timestamptz, timestamptz, text, text) TO authenticated;
