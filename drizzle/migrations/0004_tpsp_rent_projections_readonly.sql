-- Read-only 12-month rent projection layer for Tenant Ops > Tenant Products & Services.
-- Nothing here writes, mutates or normalises any existing data.

CREATE OR REPLACE VIEW public.v_tpsp_projection_base AS
WITH active AS (
  SELECT DISTINCT ON (rr.tenant_id)
    rr.id, rr.tenant_id, rr.agent_id, rr.assigned_agent_id, rr.landlord_id,
    rr.rent_amount, rr.total_repayment, rr.daily_repayment, rr.duration_days,
    rr.status, rr.funded_at, rr.disbursed_at, rr.created_at, rr.registration_type
  FROM public.rent_requests rr
  WHERE rr.tenant_id IS NOT NULL
    AND rr.status IN ('funded','disbursed','repaying')
  ORDER BY rr.tenant_id, COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) DESC
)
SELECT
  a.id            AS plan_id,
  a.tenant_id,
  COALESCE(NULLIF(btrim(tp.full_name), ''), 'Unknown') AS tenant_name,
  tp.phone        AS tenant_phone,
  a.status        AS plan_status,
  a.registration_type,
  COALESCE(a.assigned_agent_id, a.agent_id) AS agent_id,
  ap.full_name    AS agent_name,
  a.landlord_id,
  ll.name         AS landlord_name,
  h.house_id,
  h.house_label,
  loc.village_id, loc.village_name,
  loc.parish_id, loc.parish_name,
  loc.subcounty_id, loc.subcounty_name,
  loc.county_id, loc.county_name,
  loc.district_id, loc.district_name,
  loc.region,
  (loc.district_id IS NULL) AS unmapped,
  NULLIF(btrim(concat_ws(', ',
    NULLIF(btrim(COALESCE(h.house_village, tp.village)), ''),
    NULLIF(btrim(tp.parish), ''),
    NULLIF(btrim(COALESCE(h.house_sub_county, tp.sub_county)), ''),
    NULLIF(btrim(COALESCE(h.house_district, tp.district)), ''),
    NULLIF(btrim(COALESCE(h.house_region, tp.region)), '')
  )), '') AS legacy_location,
  ROUND(COALESCE(a.rent_amount, 0) * 30.0 / GREATEST(COALESCE(a.duration_days, 30), 1))     AS monthly_landlord_cost,
  ROUND(COALESCE(a.total_repayment, 0) * 30.0 / GREATEST(COALESCE(a.duration_days, 30), 1)) AS monthly_tenant_rent,
  (COALESCE(a.funded_at, a.disbursed_at, a.created_at)::date
     + COALESCE(a.duration_days, 30))                                                        AS cycle_end_date
FROM active a
JOIN public.profiles tp ON tp.id = a.tenant_id
LEFT JOIN public.profiles ap ON ap.id = COALESCE(a.assigned_agent_id, a.agent_id)
LEFT JOIN public.landlords ll ON ll.id = a.landlord_id
LEFT JOIN LATERAL (
  SELECT hl.id AS house_id,
         COALESCE(NULLIF(btrim(hl.title), ''), NULLIF(btrim(hl.address), '')) AS house_label,
         hl.ug_village_id,
         hl.region AS house_region, hl.district AS house_district,
         hl.sub_county AS house_sub_county, hl.village AS house_village
  FROM public.house_listings hl
  WHERE hl.tenant_id = a.tenant_id
  ORDER BY hl.verified DESC NULLS LAST, hl.created_at DESC
  LIMIT 1
) h ON true
LEFT JOIN LATERAL (
  SELECT v.id AS village_id, v.name AS village_name,
         pa.id AS parish_id, pa.name AS parish_name,
         sc.id AS subcounty_id, sc.name AS subcounty_name,
         cy.id AS county_id, cy.name AS county_name,
         COALESCE(dv.id, dp.id) AS district_id,
         COALESCE(dv.name, dp.name) AS district_name,
         COALESCE(dv.region, dp.region) AS region
  FROM (SELECT COALESCE(h.ug_village_id, tp.ug_village_id) AS vid) src
  LEFT JOIN public.ug_villages v ON v.id = src.vid
  LEFT JOIN public.ug_parishes pa ON pa.id = v.parish_id
  LEFT JOIN public.ug_subcounties sc ON sc.id = pa.subcounty_id
  LEFT JOIN public.ug_counties cy ON cy.id = sc.county_id
  LEFT JOIN public.ug_districts dv ON dv.id = cy.district_id
  LEFT JOIN public.ug_districts dp ON dp.id = tp.district_id
) loc ON true;

REVOKE ALL ON public.v_tpsp_projection_base FROM anon, authenticated;

-- Summary + period series + next-level breakdown, all in one round trip.
CREATE OR REPLACE FUNCTION public.tpsp_projection(
  p_grain text DEFAULT 'month',
  p_months integer DEFAULT 12,
  p_region text DEFAULT NULL,
  p_district_id integer DEFAULT NULL,
  p_county_id integer DEFAULT NULL,
  p_subcounty_id integer DEFAULT NULL,
  p_parish_id integer DEFAULT NULL,
  p_village_id integer DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_landlord_id uuid DEFAULT NULL,
  p_house_id uuid DEFAULT NULL,
  p_unmapped boolean DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_months int := LEAST(GREATEST(COALESCE(p_months, 12), 1), 24);
  v_grain text := CASE WHEN COALESCE(p_grain,'month') IN ('month','quarter','year') THEN p_grain ELSE 'month' END;
  v_start date := date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala'))::date;
  v_search text := NULLIF(btrim(COALESCE(p_search,'')), '');
  v_res jsonb;
BEGIN
  IF NOT public.ops_tps_report_authorized() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  WITH scoped AS (
    SELECT b.*
    FROM public.v_tpsp_projection_base b
    WHERE (p_region IS NULL OR b.region = p_region)
      AND (p_district_id IS NULL OR b.district_id = p_district_id)
      AND (p_county_id IS NULL OR b.county_id = p_county_id)
      AND (p_subcounty_id IS NULL OR b.subcounty_id = p_subcounty_id)
      AND (p_parish_id IS NULL OR b.parish_id = p_parish_id)
      AND (p_village_id IS NULL OR b.village_id = p_village_id)
      AND (p_agent_id IS NULL OR b.agent_id = p_agent_id)
      AND (p_landlord_id IS NULL OR b.landlord_id = p_landlord_id)
      AND (p_house_id IS NULL OR b.house_id = p_house_id)
      AND (p_unmapped IS NULL OR b.unmapped = p_unmapped)
      AND (
        v_search IS NULL
        OR b.tenant_name ILIKE '%'||v_search||'%'
        OR COALESCE(b.tenant_phone,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.agent_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.landlord_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.house_label,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.village_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.parish_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.subcounty_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.county_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.district_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.region,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.legacy_location,'') ILIKE '%'||v_search||'%'
      )
  ),
  totals AS (
    SELECT
      count(*)::int AS plans,
      count(DISTINCT tenant_id)::int AS tenants,
      count(DISTINCT landlord_id)::int AS landlords,
      count(DISTINCT house_id)::int AS houses,
      count(DISTINCT agent_id)::int AS agents,
      COALESCE(sum(monthly_tenant_rent), 0)::numeric AS monthly_tenant_rent,
      COALESCE(sum(monthly_landlord_cost), 0)::numeric AS monthly_landlord_cost,
      count(*) FILTER (WHERE unmapped)::int AS unmapped_plans
    FROM scoped
  ),
  months AS (
    SELECT (v_start + (n || ' month')::interval)::date AS m
    FROM generate_series(0, v_months - 1) n
  ),
  monthly AS (
    SELECT m.m,
           t.monthly_tenant_rent AS tenant_rent,
           t.monthly_landlord_cost AS landlord_cost
    FROM months m CROSS JOIN totals t
  ),
  series AS (
    SELECT
      CASE v_grain
        WHEN 'year' THEN to_char(date_trunc('year', m), 'YYYY-MM-DD')
        WHEN 'quarter' THEN to_char(date_trunc('quarter', m), 'YYYY-MM-DD')
        ELSE to_char(m, 'YYYY-MM-DD')
      END AS period_start,
      CASE v_grain
        WHEN 'year' THEN to_char(m, 'YYYY')
        WHEN 'quarter' THEN 'Q' || to_char(m, 'Q YYYY')
        ELSE to_char(m, 'Mon YYYY')
      END AS label,
      sum(tenant_rent)::numeric AS tenant_rent,
      sum(landlord_cost)::numeric AS landlord_cost
    FROM monthly
    GROUP BY 1, 2
  ),
  breakdown AS (
    SELECT
      CASE
        WHEN p_village_id IS NOT NULL OR p_house_id IS NOT NULL THEN 'house'
        WHEN p_parish_id IS NOT NULL THEN 'village'
        WHEN p_subcounty_id IS NOT NULL THEN 'parish'
        WHEN p_county_id IS NOT NULL THEN 'subcounty'
        WHEN p_district_id IS NOT NULL THEN 'county'
        WHEN p_region IS NOT NULL THEN 'district'
        ELSE 'region'
      END AS level,
      COALESCE(
        CASE
          WHEN p_village_id IS NOT NULL OR p_house_id IS NOT NULL THEN COALESCE(house_label, tenant_name)
          WHEN p_parish_id IS NOT NULL THEN village_name
          WHEN p_subcounty_id IS NOT NULL THEN parish_name
          WHEN p_county_id IS NOT NULL THEN subcounty_name
          WHEN p_district_id IS NOT NULL THEN county_name
          WHEN p_region IS NOT NULL THEN district_name
          ELSE region
        END, 'Unmapped') AS label,
      count(*)::int AS plans,
      COALESCE(sum(monthly_tenant_rent), 0)::numeric AS monthly_tenant_rent,
      COALESCE(sum(monthly_landlord_cost), 0)::numeric AS monthly_landlord_cost
    FROM scoped
    GROUP BY 1, 2
    ORDER BY 4 DESC
    LIMIT 50
  )
  SELECT jsonb_build_object(
    'grain', v_grain,
    'months', v_months,
    'start_month', to_char(v_start, 'YYYY-MM-DD'),
    'timezone', 'Africa/Kampala',
    'basis', 'Active plans (funded, disbursed, repaying) normalised to a 30-day month and assumed to continue for the horizon',
    'summary', (SELECT to_jsonb(t) || jsonb_build_object(
        'monthly_margin', t.monthly_tenant_rent - t.monthly_landlord_cost,
        'horizon_tenant_rent', t.monthly_tenant_rent * v_months,
        'horizon_landlord_cost', t.monthly_landlord_cost * v_months,
        'horizon_margin', (t.monthly_tenant_rent - t.monthly_landlord_cost) * v_months
      ) FROM totals t),
    'series', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'period_start', period_start, 'label', label,
        'tenant_rent', tenant_rent, 'landlord_cost', landlord_cost,
        'margin', tenant_rent - landlord_cost
      ) ORDER BY period_start) FROM series), '[]'::jsonb),
    'breakdown', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'level', level, 'label', label, 'plans', plans,
        'monthly_tenant_rent', monthly_tenant_rent,
        'monthly_landlord_cost', monthly_landlord_cost,
        'monthly_margin', monthly_tenant_rent - monthly_landlord_cost
      ) ORDER BY monthly_tenant_rent DESC) FROM breakdown), '[]'::jsonb)
  ) INTO v_res;

  RETURN v_res;
END;
$$;

-- Paginated house-level detail behind the same filters.
CREATE OR REPLACE FUNCTION public.tpsp_projection_rows(
  p_region text DEFAULT NULL,
  p_district_id integer DEFAULT NULL,
  p_county_id integer DEFAULT NULL,
  p_subcounty_id integer DEFAULT NULL,
  p_parish_id integer DEFAULT NULL,
  p_village_id integer DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_landlord_id uuid DEFAULT NULL,
  p_house_id uuid DEFAULT NULL,
  p_unmapped boolean DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_months integer DEFAULT 12,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  plan_id uuid,
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  agent_id uuid,
  agent_name text,
  landlord_id uuid,
  landlord_name text,
  house_id uuid,
  house_label text,
  location_label text,
  unmapped boolean,
  plan_status text,
  cycle_end_date date,
  monthly_tenant_rent numeric,
  monthly_landlord_cost numeric,
  monthly_margin numeric,
  horizon_tenant_rent numeric,
  horizon_margin numeric,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_months int := LEAST(GREATEST(COALESCE(p_months, 12), 1), 24);
  v_search text := NULLIF(btrim(COALESCE(p_search,'')), '');
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  IF NOT public.ops_tps_report_authorized() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT b.*
    FROM public.v_tpsp_projection_base b
    WHERE (p_region IS NULL OR b.region = p_region)
      AND (p_district_id IS NULL OR b.district_id = p_district_id)
      AND (p_county_id IS NULL OR b.county_id = p_county_id)
      AND (p_subcounty_id IS NULL OR b.subcounty_id = p_subcounty_id)
      AND (p_parish_id IS NULL OR b.parish_id = p_parish_id)
      AND (p_village_id IS NULL OR b.village_id = p_village_id)
      AND (p_agent_id IS NULL OR b.agent_id = p_agent_id)
      AND (p_landlord_id IS NULL OR b.landlord_id = p_landlord_id)
      AND (p_house_id IS NULL OR b.house_id = p_house_id)
      AND (p_unmapped IS NULL OR b.unmapped = p_unmapped)
      AND (
        v_search IS NULL
        OR b.tenant_name ILIKE '%'||v_search||'%'
        OR COALESCE(b.tenant_phone,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.agent_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.landlord_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.house_label,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.village_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.district_name,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.region,'') ILIKE '%'||v_search||'%'
        OR COALESCE(b.legacy_location,'') ILIKE '%'||v_search||'%'
      )
  ), counted AS (
    SELECT count(*) AS n FROM scoped
  )
  SELECT
    s.plan_id, s.tenant_id, s.tenant_name, s.tenant_phone,
    s.agent_id, s.agent_name, s.landlord_id, s.landlord_name,
    s.house_id, s.house_label,
    CASE WHEN s.unmapped THEN COALESCE(s.legacy_location, 'No location recorded')
         ELSE NULLIF(concat_ws(', ', s.village_name, s.parish_name, s.subcounty_name, s.county_name, s.district_name, s.region), '')
    END AS location_label,
    s.unmapped, s.plan_status, s.cycle_end_date,
    s.monthly_tenant_rent, s.monthly_landlord_cost,
    (s.monthly_tenant_rent - s.monthly_landlord_cost) AS monthly_margin,
    (s.monthly_tenant_rent * v_months) AS horizon_tenant_rent,
    ((s.monthly_tenant_rent - s.monthly_landlord_cost) * v_months) AS horizon_margin,
    c.n AS total_count
  FROM scoped s CROSS JOIN counted c
  ORDER BY s.monthly_tenant_rent DESC, s.tenant_name
  LIMIT v_limit OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

-- Filter option lists, always scoped to the current selection.
CREATE OR REPLACE FUNCTION public.tpsp_projection_filters(
  p_region text DEFAULT NULL,
  p_district_id integer DEFAULT NULL,
  p_county_id integer DEFAULT NULL,
  p_subcounty_id integer DEFAULT NULL,
  p_parish_id integer DEFAULT NULL,
  p_village_id integer DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_landlord_id uuid DEFAULT NULL,
  p_unmapped boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res jsonb;
BEGIN
  IF NOT public.ops_tps_report_authorized() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  WITH scoped AS (
    SELECT b.*
    FROM public.v_tpsp_projection_base b
    WHERE (p_region IS NULL OR b.region = p_region)
      AND (p_district_id IS NULL OR b.district_id = p_district_id)
      AND (p_county_id IS NULL OR b.county_id = p_county_id)
      AND (p_subcounty_id IS NULL OR b.subcounty_id = p_subcounty_id)
      AND (p_parish_id IS NULL OR b.parish_id = p_parish_id)
      AND (p_village_id IS NULL OR b.village_id = p_village_id)
      AND (p_agent_id IS NULL OR b.agent_id = p_agent_id)
      AND (p_landlord_id IS NULL OR b.landlord_id = p_landlord_id)
      AND (p_unmapped IS NULL OR b.unmapped = p_unmapped)
  )
  SELECT jsonb_build_object(
    'regions', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', region, 'label', region, 'plans', n) ORDER BY region)
        FROM (SELECT region, count(*) n FROM scoped WHERE region IS NOT NULL GROUP BY region) q), '[]'::jsonb),
    'districts', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', district_id, 'label', district_name, 'plans', n) ORDER BY district_name)
        FROM (SELECT district_id, district_name, count(*) n FROM scoped WHERE district_id IS NOT NULL GROUP BY 1,2) q), '[]'::jsonb),
    'counties', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', county_id, 'label', county_name, 'plans', n) ORDER BY county_name)
        FROM (SELECT county_id, county_name, count(*) n FROM scoped WHERE county_id IS NOT NULL GROUP BY 1,2) q), '[]'::jsonb),
    'subcounties', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', subcounty_id, 'label', subcounty_name, 'plans', n) ORDER BY subcounty_name)
        FROM (SELECT subcounty_id, subcounty_name, count(*) n FROM scoped WHERE subcounty_id IS NOT NULL GROUP BY 1,2) q), '[]'::jsonb),
    'parishes', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', parish_id, 'label', parish_name, 'plans', n) ORDER BY parish_name)
        FROM (SELECT parish_id, parish_name, count(*) n FROM scoped WHERE parish_id IS NOT NULL GROUP BY 1,2) q), '[]'::jsonb),
    'villages', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', village_id, 'label', village_name, 'plans', n) ORDER BY village_name)
        FROM (SELECT village_id, village_name, count(*) n FROM scoped WHERE village_id IS NOT NULL GROUP BY 1,2) q), '[]'::jsonb),
    'agents', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', agent_id, 'label', COALESCE(agent_name,'Unnamed agent'), 'plans', n) ORDER BY COALESCE(agent_name,'Unnamed agent'))
        FROM (SELECT agent_id, agent_name, count(*) n FROM scoped WHERE agent_id IS NOT NULL GROUP BY 1,2) q), '[]'::jsonb),
    'landlords', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', landlord_id, 'label', COALESCE(landlord_name,'Unnamed landlord'), 'plans', n) ORDER BY COALESCE(landlord_name,'Unnamed landlord'))
        FROM (SELECT landlord_id, landlord_name, count(*) n FROM scoped WHERE landlord_id IS NOT NULL GROUP BY 1,2) q), '[]'::jsonb),
    'houses', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', house_id, 'label', COALESCE(house_label, tenant_name), 'plans', 1) ORDER BY COALESCE(house_label, tenant_name))
        FROM (SELECT house_id, house_label, tenant_name FROM scoped WHERE house_id IS NOT NULL ORDER BY COALESCE(house_label, tenant_name) LIMIT 300) q), '[]'::jsonb),
    'unmapped_plans', (SELECT count(*) FROM scoped WHERE unmapped)
  ) INTO v_res;

  RETURN v_res;
END;
$$;

GRANT EXECUTE ON FUNCTION public.tpsp_projection(text, integer, text, integer, integer, integer, integer, integer, uuid, uuid, uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tpsp_projection_rows(text, integer, integer, integer, integer, integer, uuid, uuid, uuid, boolean, text, integer, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tpsp_projection_filters(text, integer, integer, integer, integer, integer, uuid, uuid, boolean) TO authenticated;