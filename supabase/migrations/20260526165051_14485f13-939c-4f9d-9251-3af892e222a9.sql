
-- Extend tenant-ops RPCs with optional "landlord-funded" time window and
-- return the funded date + funded amount on the leaf so the Tenant Ops
-- "Classic" view can offer Last 24h / 7d / 30d / 90d / Custom-range chips.

DROP FUNCTION IF EXISTS public.get_tenant_location_breakdown(text, text, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.get_tenants_at_leaf(text, text, text, text, uuid, uuid, integer);

CREATE OR REPLACE FUNCTION public.get_tenant_location_breakdown(
  p_level text,
  p_country text DEFAULT NULL,
  p_region  text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_ward text DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_funded_since timestamptz DEFAULT NULL,
  p_funded_until timestamptz DEFAULT NULL
) RETURNS TABLE(
  key text, label text, agent_id uuid, landlord_id uuid,
  agent_name text, landlord_name text,
  total integer, occupied integer, vacant integer, hidden integer,
  revenue_ugx bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_apply_window boolean := (p_funded_since IS NOT NULL OR p_funded_until IS NOT NULL);
BEGIN
  -- Tenants matching the optional landlord-funded window
  -- (one row per tenant if at least one disbursed payout falls inside it).
  CREATE TEMP TABLE IF NOT EXISTS _funded_tenants ON COMMIT DROP AS
  SELECT DISTINCT lp.tenant_id
  FROM landlord_payouts lp
  WHERE lp.tenant_id IS NOT NULL
    AND lp.disbursed_at IS NOT NULL
    AND (p_funded_since IS NULL OR lp.disbursed_at >= p_funded_since)
    AND (p_funded_until IS NULL OR lp.disbursed_at <  p_funded_until);

  IF p_level = 'country' THEN
    RETURN QUERY
    SELECT t.country, t.country, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    WHERE (NOT v_apply_window OR t.tenant_id IN (SELECT tenant_id FROM _funded_tenants))
    GROUP BY t.country ORDER BY COUNT(*) DESC;
  ELSIF p_level = 'region' THEN
    RETURN QUERY
    SELECT t.region, t.region, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    WHERE t.country = p_country
      AND (NOT v_apply_window OR t.tenant_id IN (SELECT tenant_id FROM _funded_tenants))
    GROUP BY t.region ORDER BY COUNT(*) DESC;
  ELSIF p_level = 'district' THEN
    RETURN QUERY
    SELECT t.district, t.district, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    WHERE t.country = p_country AND t.region = p_region
      AND (NOT v_apply_window OR t.tenant_id IN (SELECT tenant_id FROM _funded_tenants))
    GROUP BY t.district ORDER BY COUNT(*) DESC;
  ELSIF p_level = 'ward' THEN
    RETURN QUERY
    SELECT t.ward, t.ward, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    WHERE t.country = p_country AND t.region = p_region AND t.district = p_district
      AND (NOT v_apply_window OR t.tenant_id IN (SELECT tenant_id FROM _funded_tenants))
    GROUP BY t.ward ORDER BY COUNT(*) DESC;
  ELSIF p_level = 'agent' THEN
    RETURN QUERY
    SELECT COALESCE(t.agent_id::text,'unassigned'),
           COALESCE(p.full_name, CASE WHEN t.agent_id IS NULL THEN '— No agent on file' ELSE 'Unnamed agent' END),
           t.agent_id, NULL::uuid, p.full_name, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    LEFT JOIN profiles p ON p.id = t.agent_id
    WHERE t.country = p_country AND t.region = p_region
      AND t.district = p_district AND t.ward = p_ward
      AND (NOT v_apply_window OR t.tenant_id IN (SELECT tenant_id FROM _funded_tenants))
    GROUP BY t.agent_id, p.full_name ORDER BY COUNT(*) DESC;
  ELSIF p_level = 'landlord' THEN
    RETURN QUERY
    SELECT COALESCE(t.landlord_id::text,'unassigned'),
           COALESCE(p.full_name, CASE WHEN t.landlord_id IS NULL THEN '— No landlord on file' ELSE 'Unnamed landlord' END),
           t.agent_id, t.landlord_id, NULL::text, p.full_name,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    LEFT JOIN profiles p ON p.id = t.landlord_id
    WHERE t.country = p_country AND t.region = p_region
      AND t.district = p_district AND t.ward = p_ward
      AND (t.agent_id = p_agent_id OR (p_agent_id IS NULL AND t.agent_id IS NULL))
      AND (NOT v_apply_window OR t.tenant_id IN (SELECT tenant_id FROM _funded_tenants))
    GROUP BY t.landlord_id, t.agent_id, p.full_name ORDER BY COUNT(*) DESC;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_tenants_at_leaf(
  p_country text,
  p_region text,
  p_district text,
  p_ward text,
  p_agent_id uuid,
  p_landlord_id uuid,
  p_limit integer DEFAULT 300,
  p_funded_since timestamptz DEFAULT NULL,
  p_funded_until timestamptz DEFAULT NULL
) RETURNS TABLE(
  tenant_id uuid, tenant_name text, tenant_phone text,
  tenant_avatar_url text, tenant_photo_url text,
  house_image_urls text[], house_category text, rent_amount numeric,
  rent_request_id uuid, agent_id uuid, agent_name text,
  landlord_id uuid, landlord_name text,
  country text, region text, district text, ward text,
  landlord_funded_at timestamptz, landlord_funded_amount bigint,
  landlord_payout_count integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH payouts AS (
    SELECT lp.tenant_id,
           MAX(lp.disbursed_at) AS funded_at,
           COALESCE(SUM(lp.amount) FILTER (WHERE lp.disbursed_at IS NOT NULL), 0)::bigint AS funded_amount,
           COUNT(*) FILTER (WHERE lp.disbursed_at IS NOT NULL)::int AS payout_count
    FROM landlord_payouts lp
    WHERE lp.tenant_id IS NOT NULL
    GROUP BY lp.tenant_id
  )
  SELECT
    t.tenant_id, t.tenant_name, t.tenant_phone, t.tenant_avatar_url,
    t.tenant_photo_url, t.house_image_urls, t.house_category, t.rent_amount, t.rent_request_id,
    t.agent_id, pa.full_name, t.landlord_id, pl.full_name,
    t.country, t.region, t.district, t.ward,
    po.funded_at, COALESCE(po.funded_amount, 0)::bigint, COALESCE(po.payout_count, 0)::int
  FROM v_tenant_location_pivot t
  LEFT JOIN profiles pa ON pa.id = t.agent_id
  LEFT JOIN profiles pl ON pl.id = t.landlord_id
  LEFT JOIN payouts   po ON po.tenant_id = t.tenant_id
  WHERE t.country  = p_country
    AND t.region   = p_region
    AND t.district = p_district
    AND t.ward     = p_ward
    AND (t.agent_id    = p_agent_id    OR (p_agent_id    IS NULL AND t.agent_id    IS NULL))
    AND (t.landlord_id = p_landlord_id OR (p_landlord_id IS NULL AND t.landlord_id IS NULL))
    AND (p_funded_since IS NULL OR po.funded_at >= p_funded_since)
    AND (p_funded_until IS NULL OR po.funded_at <  p_funded_until)
  ORDER BY t.tenant_name NULLS LAST
  LIMIT GREATEST(p_limit, 1);
$function$;

GRANT EXECUTE ON FUNCTION public.get_tenant_location_breakdown(text, text, text, text, text, uuid, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tenants_at_leaf(text, text, text, text, uuid, uuid, integer, timestamptz, timestamptz) TO authenticated, service_role;
