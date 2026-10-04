CREATE OR REPLACE FUNCTION public.get_landlord_ops_rows(
  _search text DEFAULT NULL,
  _sort text DEFAULT 'newest',
  _category text DEFAULT 'all',
  _pending_filter text DEFAULT 'all',
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
#variable_conflict use_column
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(_limit, 20), 1), 200);
  v_offset int := GREATEST(COALESCE(_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(_search, '')), '');
  v_like text := CASE WHEN v_search IS NULL THEN NULL ELSE '%' || lower(v_search) || '%' END;
  -- When a search term is present, we bypass the verified/pending category
  -- filter so any matching landlord — verified or not — surfaces and the UI
  -- can flag it. Tenant-scoped filters (has_tenants/no_tenants) still apply.
  v_bypass_verified_filter boolean := v_search IS NOT NULL;
BEGIN
  RETURN QUERY
  WITH tc AS (
    SELECT src.landlord_id AS lid, count(DISTINCT src.tenant_id)::int AS cnt
    FROM (
      SELECT hl.landlord_id, hl.tenant_id FROM public.house_listings hl WHERE hl.tenant_id IS NOT NULL AND hl.landlord_id IS NOT NULL
      UNION
      SELECT rr.landlord_id, rr.tenant_id FROM public.rent_requests    rr WHERE rr.tenant_id IS NOT NULL AND rr.landlord_id IS NOT NULL
    ) src
    GROUP BY src.landlord_id
  ),
  base AS (
    SELECT
      l.id, l.name, l.phone, l.verified, l.has_smartphone, l.mobile_money_name, l.mobile_money_number,
      l.number_of_houses, l.bank_name, l.account_number, l.monthly_rent, l.caretaker_name, l.caretaker_phone,
      l.tin, l.electricity_meter_number, l.water_meter_number, l.village, l.district, l.region,
      l.property_address, l.tenant_id, l.registered_by, l.managed_by_agent_id, l.house_category,
      l.number_of_rooms, l.created_at,
      COALESCE(tc.cnt, 0) AS tc_count,
      (COALESCE(tc.cnt, 0) > 0 OR l.tenant_id IS NOT NULL) AS has_tenant
    FROM public.landlords l
    LEFT JOIN tc ON tc.lid = l.id
  ),
  filtered AS (
    SELECT * FROM base b
    WHERE (
        -- Verified/pending category filter is bypassed when the user is
        -- actively searching so unverified matches still surface.
        v_bypass_verified_filter AND _category IN ('all','verified','pending')
        OR _category = 'all'
        OR (_category = 'verified'    AND b.verified IS TRUE)
        OR (_category = 'pending'     AND b.verified IS NOT TRUE)
        OR (_category = 'has_tenants' AND b.has_tenant)
        OR (_category = 'no_tenants'  AND NOT b.has_tenant)
      )
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
    c.id, c.name, c.phone, c.verified, c.has_smartphone, c.mobile_money_name, c.mobile_money_number,
    c.number_of_houses, c.bank_name, c.account_number, c.monthly_rent, c.caretaker_name, c.caretaker_phone,
    c.tin, c.electricity_meter_number, c.water_meter_number, c.village, c.district, c.region,
    c.property_address, c.tenant_id, c.registered_by, c.managed_by_agent_id, c.house_category,
    c.number_of_rooms, c.created_at,
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
    -- Verified first when searching so ops sees the trusted matches at the top,
    -- but unverified matches still appear right below with the Not Verified badge.
    CASE WHEN v_search IS NOT NULL AND c.verified IS TRUE THEN 0 ELSE 1 END ASC,
    CASE WHEN _sort = 'oldest'       THEN c.created_at END ASC NULLS LAST,
    CASE WHEN _sort = 'highest_rent' THEN c.monthly_rent END DESC NULLS LAST,
    CASE WHEN _sort NOT IN ('oldest','highest_rent') THEN c.created_at END DESC NULLS LAST
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.get_landlord_ops_rows(text, text, text, text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_landlord_ops_rows(text, text, text, text, int, int) TO service_role;