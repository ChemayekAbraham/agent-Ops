DROP FUNCTION IF EXISTS public.get_tenant_location_breakdown(text, text, text, text, text, uuid, timestamptz, timestamptz);

CREATE FUNCTION public.get_tenant_location_breakdown(
  p_level text,
  p_country text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_ward text DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_funded_since timestamptz DEFAULT NULL,
  p_funded_until timestamptz DEFAULT NULL,
  p_district_id integer DEFAULT NULL,
  p_subcounty_id integer DEFAULT NULL
)
RETURNS TABLE(key text, label text, agent_id uuid, landlord_id uuid, agent_name text, landlord_name text,
              total integer, occupied integer, vacant integer, hidden integer, revenue_ugx bigint,
              district_id integer, subcounty_id integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
  WITH funded_tenants AS (
    SELECT DISTINCT lp.tenant_id
    FROM landlord_payouts lp
    WHERE lp.tenant_id IS NOT NULL
      AND lp.disbursed_at IS NOT NULL
      AND (p_funded_since IS NULL OR lp.disbursed_at >= p_funded_since)
      AND (p_funded_until IS NULL OR lp.disbursed_at <  p_funded_until)
  ),
  scoped AS (
    SELECT t.*
    FROM v_tenant_location_pivot t
    WHERE
      ((p_funded_since IS NULL AND p_funded_until IS NULL)
       OR t.tenant_id IN (SELECT tenant_id FROM funded_tenants))
      AND (p_country  IS NULL OR t.country  = p_country)
      AND (p_region   IS NULL OR t.region   = p_region)
      AND (CASE WHEN p_district_id IS NOT NULL THEN t.district_id = p_district_id
                WHEN p_district   IS NOT NULL THEN t.district = p_district
                ELSE true END)
      AND (CASE WHEN p_subcounty_id IS NOT NULL THEN t.subcounty_id = p_subcounty_id
                WHEN p_ward         IS NOT NULL THEN t.ward = p_ward
                ELSE true END)
      AND (p_agent_id IS NULL OR t.agent_id = p_agent_id)
  )
  SELECT * FROM (
    SELECT s.country AS key, s.country AS label,
           NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int AS occupied,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int     AS vacant,
           0::int AS hidden,
           COALESCE(SUM(s.rent_amount),0)::bigint AS revenue_ugx,
           NULL::int AS district_id, NULL::int AS subcounty_id
    FROM scoped s
    WHERE p_level = 'country'
    GROUP BY s.country

    UNION ALL
    SELECT s.region, s.region, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(s.rent_amount),0)::bigint,
           NULL::int, NULL::int
    FROM scoped s
    WHERE p_level = 'region'
    GROUP BY s.region

    UNION ALL
    SELECT s.district, s.district, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(s.rent_amount),0)::bigint,
           MAX(s.district_id)::int, NULL::int
    FROM scoped s
    WHERE p_level = 'district'
    GROUP BY s.district

    UNION ALL
    SELECT s.ward, s.ward, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(s.rent_amount),0)::bigint,
           MAX(s.district_id)::int, MAX(s.subcounty_id)::int
    FROM scoped s
    WHERE p_level = 'ward'
    GROUP BY s.ward

    UNION ALL
    SELECT COALESCE(s.agent_id::text,'unassigned'),
           COALESCE(p.full_name, CASE WHEN s.agent_id IS NULL THEN '— No agent on file' ELSE 'Unnamed agent' END),
           s.agent_id, NULL::uuid, p.full_name, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(s.rent_amount),0)::bigint,
           MAX(s.district_id)::int, MAX(s.subcounty_id)::int
    FROM scoped s
    LEFT JOIN profiles p ON p.id = s.agent_id
    WHERE p_level = 'agent'
    GROUP BY s.agent_id, p.full_name

    UNION ALL
    SELECT COALESCE(s.landlord_id::text,'unassigned'),
           COALESCE(p.full_name, CASE WHEN s.landlord_id IS NULL THEN '— No landlord on file' ELSE 'Unnamed landlord' END),
           NULL::uuid, s.landlord_id, NULL::text, p.full_name,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(s.rent_amount),0)::bigint,
           MAX(s.district_id)::int, MAX(s.subcounty_id)::int
    FROM scoped s
    LEFT JOIN profiles p ON p.id = s.landlord_id
    WHERE p_level = 'landlord'
    GROUP BY s.landlord_id, p.full_name
  ) q
  ORDER BY q.total DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_tenant_location_breakdown(text, text, text, text, text, uuid, timestamptz, timestamptz, integer, integer) TO authenticated, service_role;