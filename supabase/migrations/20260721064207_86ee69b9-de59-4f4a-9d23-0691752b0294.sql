
-- Supporting indexes for the aggregate/filter workload
CREATE INDEX IF NOT EXISTS idx_landlords_verified ON public.landlords(verified);
CREATE INDEX IF NOT EXISTS idx_landlords_smartphone ON public.landlords(has_smartphone) WHERE has_smartphone IS TRUE;

-- ============================================================
-- TOTALS: single aggregate row (fast, indexed, no row transfer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_landlord_ops_totals()
RETURNS TABLE(
  total bigint,
  verified bigint,
  pending bigint,
  has_tenants bigint,
  no_tenants bigint,
  smartphone bigint,
  occupied_monthly_revenue numeric,
  empty_monthly_revenue numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH tenant_landlords AS (
    -- Any landlord id that shows up as having a tenant, from either linkage
    SELECT DISTINCT landlord_id FROM public.house_listings WHERE tenant_id IS NOT NULL AND landlord_id IS NOT NULL
    UNION
    SELECT DISTINCT landlord_id FROM public.rent_requests    WHERE tenant_id IS NOT NULL AND landlord_id IS NOT NULL
    UNION
    SELECT DISTINCT id AS landlord_id FROM public.landlords  WHERE tenant_id IS NOT NULL
  )
  SELECT
    (SELECT count(*) FROM public.landlords)::bigint                                             AS total,
    (SELECT count(*) FROM public.landlords WHERE verified IS TRUE)::bigint                       AS verified,
    (SELECT count(*) FROM public.landlords WHERE verified IS NOT TRUE)::bigint                   AS pending,
    (SELECT count(*) FROM tenant_landlords)::bigint                                              AS has_tenants,
    (
      (SELECT count(*) FROM public.landlords)
      - (SELECT count(*) FROM tenant_landlords)
    )::bigint                                                                                    AS no_tenants,
    (SELECT count(*) FROM public.landlords WHERE has_smartphone IS TRUE)::bigint                 AS smartphone,
    COALESCE((
      SELECT sum(COALESCE(l.monthly_rent, 0))
      FROM public.landlords l
      WHERE l.id IN (SELECT landlord_id FROM tenant_landlords)
    ), 0)                                                                                        AS occupied_monthly_revenue,
    COALESCE((
      SELECT sum(COALESCE(l.monthly_rent, 0))
      FROM public.landlords l
      WHERE l.id NOT IN (SELECT landlord_id FROM tenant_landlords)
    ), 0)                                                                                        AS empty_monthly_revenue;
$$;

REVOKE ALL ON FUNCTION public.get_landlord_ops_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_landlord_ops_totals() TO service_role;

-- ============================================================
-- ROWS: one page + total_matched (server-side search/sort/filter)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_landlord_ops_rows(
  _search text DEFAULT NULL,
  _sort text DEFAULT 'newest',              -- newest | oldest | highest_rent
  _category text DEFAULT 'all',             -- all | verified | pending | has_tenants | no_tenants
  _pending_filter text DEFAULT 'all',       -- all | has_address | has_phone | has_smartphone | has_bank | has_momo
  _limit int DEFAULT 20,
  _offset int DEFAULT 0
)
RETURNS TABLE(
  id uuid,
  name text,
  phone text,
  verified boolean,
  has_smartphone boolean,
  mobile_money_name text,
  mobile_money_number text,
  number_of_houses integer,
  bank_name text,
  account_number text,
  monthly_rent numeric,
  caretaker_name text,
  caretaker_phone text,
  tin text,
  electricity_meter_number text,
  water_meter_number text,
  village text,
  district text,
  region text,
  property_address text,
  tenant_id uuid,
  registered_by uuid,
  managed_by_agent_id uuid,
  house_category text,
  number_of_rooms integer,
  created_at timestamptz,
  tenant_count integer,
  agent_name text,
  agent_phone text,
  primary_tenant_name text,
  primary_tenant_phone text,
  total_matched bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(_limit, 20), 1), 200);
  v_offset int := GREATEST(COALESCE(_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(_search, '')), '');
  v_like text := CASE WHEN v_search IS NULL THEN NULL ELSE '%' || lower(v_search) || '%' END;
BEGIN
  RETURN QUERY
  WITH tenant_counts AS (
    SELECT landlord_id, count(DISTINCT tenant_id)::int AS cnt
    FROM (
      SELECT landlord_id, tenant_id FROM public.house_listings WHERE tenant_id IS NOT NULL AND landlord_id IS NOT NULL
      UNION
      SELECT landlord_id, tenant_id FROM public.rent_requests    WHERE tenant_id IS NOT NULL AND landlord_id IS NOT NULL
    ) src
    GROUP BY landlord_id
  ),
  base AS (
    SELECT
      l.*,
      COALESCE(tc.cnt, 0) AS tc_count,
      (COALESCE(tc.cnt, 0) > 0 OR l.tenant_id IS NOT NULL) AS has_tenant
    FROM public.landlords l
    LEFT JOIN tenant_counts tc ON tc.landlord_id = l.id
  ),
  filtered AS (
    SELECT * FROM base b
    WHERE
      (_category = 'all')
      OR (_category = 'verified'    AND b.verified IS TRUE)
      OR (_category = 'pending'     AND b.verified IS NOT TRUE)
      OR (_category = 'has_tenants' AND b.has_tenant)
      OR (_category = 'no_tenants'  AND NOT b.has_tenant)
    -- Pending sub-filter only applies within pending category
    AND (
      _category <> 'pending'
      OR _pending_filter = 'all'
      OR (_pending_filter = 'has_address'    AND b.property_address IS NOT NULL AND btrim(b.property_address) <> '')
      OR (_pending_filter = 'has_phone'      AND b.phone IS NOT NULL AND length(b.phone) >= 9)
      OR (_pending_filter = 'has_smartphone' AND b.has_smartphone IS TRUE)
      OR (_pending_filter = 'has_bank'       AND b.bank_name IS NOT NULL AND b.account_number IS NOT NULL)
      OR (_pending_filter = 'has_momo'       AND b.mobile_money_number IS NOT NULL)
    )
    AND (
      v_like IS NULL
      OR lower(COALESCE(b.name, ''))             LIKE v_like
      OR lower(COALESCE(b.phone, ''))            LIKE v_like
      OR lower(COALESCE(b.district, ''))         LIKE v_like
      OR lower(COALESCE(b.region, ''))           LIKE v_like
      OR lower(COALESCE(b.village, ''))          LIKE v_like
      OR lower(COALESCE(b.property_address, '')) LIKE v_like
    )
  ),
  counted AS (
    SELECT f.*, count(*) OVER () AS tm FROM filtered f
  )
  SELECT
    c.id,
    c.name,
    c.phone,
    c.verified,
    c.has_smartphone,
    c.mobile_money_name,
    c.mobile_money_number,
    c.number_of_houses,
    c.bank_name,
    c.account_number,
    c.monthly_rent,
    c.caretaker_name,
    c.caretaker_phone,
    c.tin,
    c.electricity_meter_number,
    c.water_meter_number,
    c.village,
    c.district,
    c.region,
    c.property_address,
    c.tenant_id,
    c.registered_by,
    c.managed_by_agent_id,
    c.house_category,
    c.number_of_rooms,
    c.created_at,
    c.tc_count AS tenant_count,
    COALESCE(pa_mgr.full_name, pa_reg.full_name) AS agent_name,
    COALESCE(pa_mgr.phone, pa_reg.phone)         AS agent_phone,
    pt.full_name                                  AS primary_tenant_name,
    pt.phone                                      AS primary_tenant_phone,
    c.tm                                          AS total_matched
  FROM counted c
  LEFT JOIN public.profiles pa_mgr ON pa_mgr.id = c.managed_by_agent_id
  LEFT JOIN public.profiles pa_reg ON pa_reg.id = c.registered_by
  LEFT JOIN public.profiles pt     ON pt.id     = c.tenant_id
  ORDER BY
    CASE WHEN _sort = 'oldest'       THEN c.created_at END ASC NULLS LAST,
    CASE WHEN _sort = 'highest_rent' THEN c.monthly_rent END DESC NULLS LAST,
    CASE WHEN _sort NOT IN ('oldest','highest_rent') THEN c.created_at END DESC NULLS LAST
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.get_landlord_ops_rows(text, text, text, text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_landlord_ops_rows(text, text, text, text, int, int) TO service_role;
