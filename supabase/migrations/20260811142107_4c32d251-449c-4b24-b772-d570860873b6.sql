-- 1. Date-range aware landlord list (backwards compatible: new args default to NULL)
CREATE OR REPLACE FUNCTION public.get_landlord_ops_rows(
  _search text DEFAULT NULL::text,
  _sort text DEFAULT 'newest'::text,
  _category text DEFAULT 'all'::text,
  _pending_filter text DEFAULT 'all'::text,
  _limit integer DEFAULT 20,
  _offset integer DEFAULT 0,
  _date_from timestamptz DEFAULT NULL,
  _date_to timestamptz DEFAULT NULL
)
RETURNS TABLE(id uuid, name text, phone text, verified boolean, verification_status text, verification_source text, verification_reason text, verification_updated_at timestamp with time zone, has_smartphone boolean, mobile_money_name text, mobile_money_number text, number_of_houses integer, bank_name text, account_number text, monthly_rent numeric, caretaker_name text, caretaker_phone text, tin text, electricity_meter_number text, water_meter_number text, village text, district text, region text, property_address text, tenant_id uuid, registered_by uuid, managed_by_agent_id uuid, house_category text, number_of_rooms integer, created_at timestamp with time zone, tenant_count integer, agent_name text, agent_phone text, primary_tenant_name text, primary_tenant_phone text, total_matched bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(_limit, 20), 1), 5000);
  v_offset int := GREATEST(COALESCE(_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(_search, '')), '');
  v_like text := CASE WHEN v_search IS NULL THEN NULL ELSE '%' || lower(v_search) || '%' END;
  v_bypass_status boolean := v_search IS NOT NULL;
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      l.id, l.name, l.phone, l.verified,
      v.status AS v_status, v.source AS v_source,
      l.verification_reason, l.verification_updated_at,
      l.has_smartphone, l.mobile_money_name, l.mobile_money_number,
      l.number_of_houses, l.bank_name, l.account_number, l.monthly_rent, l.caretaker_name, l.caretaker_phone,
      l.tin, l.electricity_meter_number, l.water_meter_number, l.village, l.district, l.region,
      l.property_address, l.tenant_id, l.registered_by, l.managed_by_agent_id, l.house_category,
      l.number_of_rooms, l.created_at,
      v.tenant_count AS tc_count,
      v.has_tenant,
      -- State date: pending has no decision yet, so registration date applies.
      CASE WHEN v.status = 'pending' THEN l.created_at
           ELSE COALESCE(l.verification_updated_at, l.created_at) END AS activity_at
    FROM public.landlords l
    JOIN public.v_landlord_ops_status v ON v.landlord_id = l.id
  ),
  filtered AS (
    SELECT * FROM base b
    WHERE (
        (v_bypass_status AND _category IN ('all','verified','pending','rejected','resubmitted'))
        OR _category = 'all'
        OR (_category = 'verified'    AND b.v_status = 'verified')
        OR (_category = 'pending'     AND b.v_status = 'pending')
        OR (_category = 'rejected'    AND b.v_status = 'rejected')
        OR (_category = 'resubmitted' AND b.v_status = 'resubmitted')
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
      AND (_date_from IS NULL OR b.activity_at >= _date_from)
      AND (_date_to   IS NULL OR b.activity_at <= _date_to)
  ),
  counted AS (
    SELECT f.*, count(*) OVER () AS tm FROM filtered f
  )
  SELECT
    c.id, c.name, c.phone, c.verified, c.v_status, c.v_source,
    c.verification_reason, c.verification_updated_at,
    c.has_smartphone, c.mobile_money_name, c.mobile_money_number,
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
    CASE WHEN v_search IS NOT NULL AND c.v_status = 'verified' THEN 0 ELSE 1 END ASC,
    CASE WHEN _sort = 'oldest'       THEN c.created_at END ASC NULLS LAST,
    CASE WHEN _sort = 'highest_rent' THEN c.monthly_rent END DESC NULLS LAST,
    CASE WHEN _sort NOT IN ('oldest','highest_rent') THEN c.created_at END DESC NULLS LAST
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$;

-- 2. Per-status counts honouring search + date range (mirrors ops_house_listing_status_counts)
CREATE OR REPLACE FUNCTION public.ops_landlord_status_counts(
  p_search text DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS TABLE(
  all_landlords bigint,
  verified bigint,
  pending bigint,
  rejected bigint,
  resubmitted bigint,
  has_tenants bigint,
  no_tenants bigint,
  verified_human bigint,
  verified_auto bigint,
  smartphone bigint,
  occupied_monthly_revenue numeric,
  empty_monthly_revenue numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH src AS (
    SELECT
      v.status, v.source, v.has_tenant, v.has_smartphone, v.monthly_rent
    FROM public.landlords l
    JOIN public.v_landlord_ops_status v ON v.landlord_id = l.id
    WHERE (
        NULLIF(btrim(COALESCE(p_search, '')), '') IS NULL
        OR lower(COALESCE(l.name, ''))             LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(l.phone, ''))            LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(l.district, ''))         LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(l.region, ''))           LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(l.village, ''))          LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(l.property_address, '')) LIKE '%' || lower(btrim(p_search)) || '%'
      )
      AND (p_date_from IS NULL OR (CASE WHEN v.status = 'pending' THEN l.created_at ELSE COALESCE(l.verification_updated_at, l.created_at) END) >= p_date_from)
      AND (p_date_to   IS NULL OR (CASE WHEN v.status = 'pending' THEN l.created_at ELSE COALESCE(l.verification_updated_at, l.created_at) END) <= p_date_to)
  )
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE status = 'verified')::bigint,
    count(*) FILTER (WHERE status = 'pending')::bigint,
    count(*) FILTER (WHERE status = 'rejected')::bigint,
    count(*) FILTER (WHERE status = 'resubmitted')::bigint,
    count(*) FILTER (WHERE has_tenant)::bigint,
    count(*) FILTER (WHERE NOT has_tenant)::bigint,
    count(*) FILTER (WHERE status = 'verified' AND source <> 'pipeline_auto')::bigint,
    count(*) FILTER (WHERE status = 'verified' AND source = 'pipeline_auto')::bigint,
    count(*) FILTER (WHERE has_smartphone IS TRUE)::bigint,
    COALESCE(sum(monthly_rent) FILTER (WHERE has_tenant), 0),
    COALESCE(sum(monthly_rent) FILTER (WHERE NOT has_tenant), 0)
  FROM src;
$function$;

-- 3. Full report payload for the landlord verification PDF export
CREATE OR REPLACE FUNCTION public.ops_landlord_report(
  p_status text DEFAULT 'all',
  p_search text DEFAULT NULL,
  p_quick text DEFAULT 'all',
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 10000
)
RETURNS TABLE(row_data jsonb, total_count bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT
      l.*,
      v.status AS v_status,
      v.source AS v_source,
      v.tenant_count AS tc_count,
      v.has_tenant,
      CASE WHEN v.status = 'pending' THEN l.created_at
           ELSE COALESCE(l.verification_updated_at, l.created_at) END AS activity_at
    FROM public.landlords l
    JOIN public.v_landlord_ops_status v ON v.landlord_id = l.id
  ),
  filtered AS (
    SELECT b.* FROM base b
    WHERE (
        COALESCE(p_status, 'all') = 'all'
        OR (p_status = 'has_tenants' AND b.has_tenant)
        OR (p_status = 'no_tenants'  AND NOT b.has_tenant)
        OR b.v_status = p_status
      )
      AND (
        COALESCE(p_quick, 'all') = 'all'
        OR (p_quick = 'has_address'    AND b.property_address IS NOT NULL AND btrim(b.property_address) <> '')
        OR (p_quick = 'has_phone'      AND b.phone IS NOT NULL AND length(b.phone) >= 9)
        OR (p_quick = 'has_smartphone' AND b.has_smartphone IS TRUE)
        OR (p_quick = 'has_bank'       AND b.bank_name IS NOT NULL AND b.account_number IS NOT NULL)
        OR (p_quick = 'has_momo'       AND b.mobile_money_number IS NOT NULL)
      )
      AND (
        NULLIF(btrim(COALESCE(p_search, '')), '') IS NULL
        OR lower(COALESCE(b.name, ''))             LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(b.phone, ''))            LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(b.district, ''))         LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(b.region, ''))           LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(b.village, ''))          LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(b.property_address, '')) LIKE '%' || lower(btrim(p_search)) || '%'
      )
      AND (p_date_from IS NULL OR b.activity_at >= p_date_from)
      AND (p_date_to   IS NULL OR b.activity_at <= p_date_to)
  ),
  counted AS (SELECT f.*, count(*) OVER () AS tm FROM filtered f)
  SELECT
    jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'phone', c.phone,
      'status', c.v_status,
      'source', c.v_source,
      'verification_reason', c.verification_reason,
      'verification_updated_at', c.verification_updated_at,
      'verified_by_name', pv.full_name,
      'created_at', c.created_at,
      'activity_at', c.activity_at,
      'village', c.village,
      'district', c.district,
      'region', c.region,
      'property_address', c.property_address,
      'monthly_rent', c.monthly_rent,
      'number_of_houses', c.number_of_houses,
      'number_of_rooms', c.number_of_rooms,
      'house_category', c.house_category,
      'has_smartphone', c.has_smartphone,
      'mobile_money_name', c.mobile_money_name,
      'mobile_money_number', c.mobile_money_number,
      'bank_name', c.bank_name,
      'account_number', c.account_number,
      'caretaker_name', c.caretaker_name,
      'caretaker_phone', c.caretaker_phone,
      'tin', c.tin,
      'tenant_count', c.tc_count,
      'has_tenant', c.has_tenant,
      'agent_name', COALESCE(pa_mgr.full_name, pa_reg.full_name),
      'agent_phone', COALESCE(pa_mgr.phone, pa_reg.phone),
      'tenant_name', pt.full_name,
      'tenant_phone', pt.phone
    ) AS row_data,
    c.tm AS total_count
  FROM counted c
  LEFT JOIN public.profiles pa_mgr ON pa_mgr.id = c.managed_by_agent_id
  LEFT JOIN public.profiles pa_reg ON pa_reg.id = c.registered_by
  LEFT JOIN public.profiles pt     ON pt.id     = c.tenant_id
  LEFT JOIN public.profiles pv     ON pv.id     = c.verified_by
  ORDER BY c.activity_at DESC NULLS LAST
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10000), 1), 20000);
$function$;

REVOKE ALL ON FUNCTION public.ops_landlord_status_counts(text, timestamptz, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.ops_landlord_report(text, text, text, timestamptz, timestamptz, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.ops_landlord_status_counts(text, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ops_landlord_report(text, text, text, timestamptz, timestamptz, integer) TO authenticated, service_role;