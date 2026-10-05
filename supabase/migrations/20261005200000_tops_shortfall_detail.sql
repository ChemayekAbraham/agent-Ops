-- tops_shortfall_detail: the drill-down list behind tops_shortfall_breakdown — one row per
-- short Rent Plan, optionally filtered to one group (one agent, one district, ...), with
-- search, whitelisted sorting and server-side paging. Read-only, additive: one new
-- function, nothing existing is altered.
--
-- Rows come from public.tops_shortfall_lines (the maths is never re-derived here). The
-- group key mapping is the same as tops_shortfall_breakdown, so for any key returned by
-- the breakdown, total_count = plan_count and total_short_ugx = short_ugx.
--
-- Every column reference is alias-qualified; sorting uses a fixed CASE over a whitelist
-- (no dynamic SQL, nothing user-supplied is ever interpolated).

CREATE OR REPLACE FUNCTION public.tops_shortfall_detail(
  p_start timestamptz,
  p_end timestamptz,
  p_group text DEFAULT NULL,
  p_group_key text DEFAULT NULL,
  p_area_level text DEFAULT 'district',
  p_search text DEFAULT NULL,
  p_sort text DEFAULT 'short_ugx',
  p_dir text DEFAULT 'desc',
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_sort text := lower(COALESCE(NULLIF(trim(p_sort), ''), 'short_ugx'));
  v_dir text := lower(COALESCE(NULLIF(trim(p_dir), ''), 'desc'));
  v_sign int;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(trim(COALESCE(p_search, '')), '');
  v_tokens text[];
  v_digits text;
  v_phone_like boolean := false;
  v_phone_prefix text;
  v_phone_sub text;
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF v_sort NOT IN ('short_ugx', 'expected_ugx', 'collected_ugx', 'days_behind', 'periods_behind',
                    'oldest_unpaid_due', 'last_paid_at', 'tenant_name', 'agent_name', 'service_centre',
                    'district', 'plan_code') THEN
    RAISE EXCEPTION 'invalid sort: %, expected short_ugx/expected_ugx/collected_ugx/days_behind/periods_behind/oldest_unpaid_due/last_paid_at/tenant_name/agent_name/service_centre/district/plan_code', p_sort;
  END IF;
  IF v_dir NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'invalid direction: %, expected asc/desc', p_dir;
  END IF;
  v_sign := CASE WHEN v_dir = 'asc' THEN 1 ELSE -1 END;

  IF (p_group IS NULL) <> (p_group_key IS NULL) THEN
    RAISE EXCEPTION 'p_group and p_group_key must be given together';
  END IF;
  IF p_group IS NOT NULL AND p_group NOT IN ('tenant', 'agent', 'service_centre', 'area', 'ageing') THEN
    RAISE EXCEPTION 'invalid group: %, expected tenant/agent/service_centre/area/ageing', p_group;
  END IF;
  IF p_group = 'area' AND (p_area_level IS NULL OR p_area_level NOT IN ('region', 'district', 'county', 'subcounty', 'parish', 'village')) THEN
    RAISE EXCEPTION 'invalid level: %, expected region/district/county/subcounty/parish/village', p_area_level;
  END IF;

  IF v_search IS NOT NULL THEN
    -- Name search: every typed word must appear (any order) in the tenant's name, or
    -- every word in the agent's name. LIKE wildcards in the input are escaped.
    v_tokens := ARRAY(
      SELECT regexp_replace(lower(t.w), '([\\%_])', '\\\1', 'g')
      FROM regexp_split_to_table(v_search, '\s+') AS t(w)
      WHERE t.w <> ''
    );
    -- Phone search: looks like a number when it is only digits/+/spaces/brackets/dashes.
    v_digits := regexp_replace(v_search, '\D', '', 'g');
    v_phone_like := v_search ~ '^[+0-9 ()\-]+$' AND length(v_digits) >= 3;
    IF v_phone_like THEN
      IF v_search ~ '^\+' OR v_digits ~ '^(0|256)' THEN
        -- Written as a phone number (0… or +256… / 256…): match from the start of the
        -- 9-digit national number, so 0772…, +256772… and 256772… all behave the same.
        v_phone_prefix := regexp_replace(v_digits, '^(256|0)', '');
      ELSE
        v_phone_sub := v_digits;
      END IF;
    END IF;
  END IF;

  WITH l AS (
    SELECT * FROM public.tops_shortfall_lines(p_start, p_end)
  ),
  agent_centre AS (
    SELECT DISTINCT ON (a.agent_id) a.agent_id AS ag_id, a.service_centre_id AS sc_id
    FROM public.service_centre_agent_assignments a
    WHERE a.status = 'active'
    ORDER BY a.agent_id, a.assigned_at DESC, a.id
  ),
  base AS (
    SELECT
      l.rent_request_id AS rr_id,
      left(l.rent_request_id::text, 8) AS plan_code,
      l.tenant_id AS tn_id,
      NULLIF(trim(tp.full_name), '') AS tn_name,
      NULLIF(tp.phone, '') AS tn_phone,
      regexp_replace(regexp_replace(COALESCE(tp.phone, ''), '\D', '', 'g'), '^(256|0)', '') AS tn_nat,
      l.agent_id AS ag_id,
      NULLIF(trim(ap.full_name), '') AS ag_name,
      NULLIF(ap.phone, '') AS ag_phone,
      regexp_replace(regexp_replace(COALESCE(ap.phone, ''), '\D', '', 'g'), '^(256|0)', '') AS ag_nat,
      sc.id AS sc_id,
      CASE WHEN sc.id IS NULL THEN 'No service centre'
           ELSE COALESCE(NULLIF(trim(sc.location_name), ''), sc.agent_name) END AS sc_name,
      tb.district_name AS district,
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
      l.expected_ugx AS exp_ugx,
      l.collected_capped_ugx AS col_ugx,
      l.short_ugx AS sh_ugx,
      l.days_behind AS dbh,
      l.periods_behind AS pbh,
      l.cadence AS cad,
      l.oldest_unpaid_due AS oud,
      l.last_paid_at AS lpa
    FROM l
    LEFT JOIN public.profiles tp ON tp.id = l.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = l.agent_id
    LEFT JOIN agent_centre ac ON ac.ag_id = l.agent_id
    LEFT JOIN public.service_centre_setups sc ON sc.id = ac.sc_id
    LEFT JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = l.tenant_id
    LEFT JOIN LATERAL (
      SELECT
        CASE p_area_level
          WHEN 'region' THEN tb.region
          WHEN 'district' THEN tb.district_id::text
          WHEN 'county' THEN tb.county_id::text
          WHEN 'subcounty' THEN tb.subcounty_id::text
          WHEN 'parish' THEN tb.parish_id::text
          WHEN 'village' THEN tb.village_id::text
        END AS k_raw
    ) ar ON true
  ),
  filtered AS (
    SELECT b.*
    FROM base b
    WHERE (p_group IS NULL OR b.gk = p_group_key)
      AND (
        v_search IS NULL
        OR (
          b.tn_name IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM unnest(v_tokens) AS t(w) WHERE b.tn_name NOT ILIKE '%' || t.w || '%')
        )
        OR (
          b.ag_name IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM unnest(v_tokens) AS t(w) WHERE b.ag_name NOT ILIKE '%' || t.w || '%')
        )
        OR (
          v_phone_like AND (
            (v_phone_prefix IS NOT NULL AND (b.tn_nat LIKE v_phone_prefix || '%' OR b.ag_nat LIKE v_phone_prefix || '%'))
            OR (v_phone_sub IS NOT NULL AND (b.tn_nat LIKE '%' || v_phone_sub || '%' OR b.ag_nat LIKE '%' || v_phone_sub || '%'))
          )
        )
      )
  ),
  ranked AS (
    SELECT
      f.*,
      count(*) OVER () AS n_total,
      sum(f.sh_ugx) OVER () AS s_total,
      row_number() OVER (
        ORDER BY
          (CASE v_sort
             WHEN 'short_ugx' THEN f.sh_ugx
             WHEN 'expected_ugx' THEN f.exp_ugx
             WHEN 'collected_ugx' THEN f.col_ugx
             WHEN 'days_behind' THEN f.dbh::numeric
             WHEN 'periods_behind' THEN f.pbh::numeric
             WHEN 'oldest_unpaid_due' THEN (f.oud - DATE '1970-01-01')::numeric
             WHEN 'last_paid_at' THEN extract(epoch FROM f.lpa)::numeric
           END) * v_sign ASC NULLS LAST,
          (CASE WHEN v_dir = 'asc' THEN
             CASE v_sort
               WHEN 'tenant_name' THEN lower(f.tn_name)
               WHEN 'agent_name' THEN lower(f.ag_name)
               WHEN 'service_centre' THEN lower(f.sc_name)
               WHEN 'district' THEN lower(f.district)
               WHEN 'plan_code' THEN f.plan_code
             END
           END) ASC NULLS LAST,
          (CASE WHEN v_dir = 'desc' THEN
             CASE v_sort
               WHEN 'tenant_name' THEN lower(f.tn_name)
               WHEN 'agent_name' THEN lower(f.ag_name)
               WHEN 'service_centre' THEN lower(f.sc_name)
               WHEN 'district' THEN lower(f.district)
               WHEN 'plan_code' THEN f.plan_code
             END
           END) DESC NULLS LAST,
          f.sh_ugx DESC,
          f.rr_id
      ) AS rn
    FROM filtered f
  )
  SELECT jsonb_build_object(
    'total_count', COALESCE(max(r.n_total), 0),
    'total_short_ugx', COALESCE(max(r.s_total), 0),
    'rows', COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'rent_request_id', r.rr_id,
          'plan_code', r.plan_code,
          'tenant_id', r.tn_id,
          'tenant_name', r.tn_name,
          'tenant_phone', r.tn_phone,
          'agent_id', r.ag_id,
          'agent_name', r.ag_name,
          'agent_phone', r.ag_phone,
          'service_centre_id', r.sc_id,
          'service_centre', r.sc_name,
          'district', r.district,
          'expected_ugx', r.exp_ugx,
          'collected_ugx', r.col_ugx,
          'short_ugx', r.sh_ugx,
          'days_behind', r.dbh,
          'periods_behind', r.pbh,
          'cadence', r.cad,
          'cadence_label', CASE
            WHEN r.pbh IS NULL THEN NULL
            ELSE r.pbh::text || ' ' ||
                 CASE r.cad WHEN 'daily' THEN 'day' WHEN 'weekly' THEN 'week' WHEN 'monthly' THEN 'month' END ||
                 CASE WHEN r.pbh = 1 THEN '' ELSE 's' END
          END,
          'oldest_unpaid_due', r.oud,
          'last_paid_at', r.lpa
        )
        ORDER BY r.rn
      ) FILTER (WHERE r.rn > v_offset AND r.rn <= v_offset + v_limit),
      '[]'::jsonb
    )
  )
  INTO v_result
  FROM ranked r;

  RETURN v_result;
END;
$function$;

-- This schema's default privileges auto-grant new functions to anon; revoke explicitly.
REVOKE ALL ON FUNCTION public.tops_shortfall_detail(timestamptz, timestamptz, text, text, text, text, text, text, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_shortfall_detail(timestamptz, timestamptz, text, text, text, text, text, text, int, int) TO authenticated;
