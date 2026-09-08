-- Legacy tenant location correction workflow (read + location-only write).
-- Uses the existing ug_* approved dataset as the single source of truth.
-- A tenant is "unmatched" when profiles.ug_village_id IS NULL.

CREATE OR REPLACE FUNCTION public.tenant_location_correction_progress(p_agent_id uuid DEFAULT NULL)
RETURNS TABLE (total_tenants bigint, matched bigint, unmatched bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_agent_id IS NULL THEN
    IF NOT public.is_ops_role(v_actor) THEN
      RAISE EXCEPTION 'Not authorised';
    END IF;
  ELSIF p_agent_id <> v_actor AND NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT DISTINCT r.tenant_id
    FROM public.rent_requests r
    WHERE r.tenant_id IS NOT NULL
      AND (p_agent_id IS NULL OR r.agent_id = p_agent_id OR r.assigned_agent_id = p_agent_id)
  )
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE p.ug_village_id IS NOT NULL)::bigint,
    count(*) FILTER (WHERE p.ug_village_id IS NULL)::bigint
  FROM base b
  JOIN public.profiles p ON p.id = b.tenant_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_location_corrections(
  p_agent_id uuid DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  legacy_region text,
  legacy_district text,
  legacy_sub_county text,
  legacy_parish text,
  legacy_village text,
  monthly_rent numeric,
  agent_id uuid,
  agent_name text,
  agent_phone text,
  request_status text,
  requested_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_q text := NULLIF(btrim(coalesce(p_search, '')), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_agent_id IS NULL THEN
    IF NOT public.is_ops_role(v_actor) THEN
      RAISE EXCEPTION 'Not authorised';
    END IF;
  ELSIF p_agent_id <> v_actor AND NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT DISTINCT ON (r.tenant_id)
      r.tenant_id, r.agent_id, r.assigned_agent_id, r.status, r.created_at
    FROM public.rent_requests r
    WHERE r.tenant_id IS NOT NULL
      AND (p_agent_id IS NULL OR r.agent_id = p_agent_id OR r.assigned_agent_id = p_agent_id)
    ORDER BY r.tenant_id, r.created_at DESC
  ), matched_rows AS (
    SELECT
      tp.id AS tenant_id,
      tp.full_name AS tenant_name,
      tp.phone AS tenant_phone,
      tp.region AS legacy_region,
      tp.district AS legacy_district,
      tp.sub_county AS legacy_sub_county,
      tp.parish AS legacy_parish,
      tp.village AS legacy_village,
      tp.monthly_rent,
      coalesce(b.agent_id, b.assigned_agent_id) AS agent_id,
      ap.full_name AS agent_name,
      ap.phone AS agent_phone,
      b.status AS request_status,
      b.created_at AS requested_at
    FROM base b
    JOIN public.profiles tp ON tp.id = b.tenant_id AND tp.ug_village_id IS NULL
    LEFT JOIN public.profiles ap ON ap.id = coalesce(b.agent_id, b.assigned_agent_id)
    WHERE v_q IS NULL
      OR tp.full_name ILIKE '%' || v_q || '%'
      OR tp.phone ILIKE '%' || v_q || '%'
      OR coalesce(tp.district, '') ILIKE '%' || v_q || '%'
      OR coalesce(tp.village, '') ILIKE '%' || v_q || '%'
      OR coalesce(ap.full_name, '') ILIKE '%' || v_q || '%'
      OR coalesce(ap.phone, '') ILIKE '%' || v_q || '%'
  )
  SELECT r.*, count(*) OVER ()::bigint AS total_count
  FROM matched_rows r
  ORDER BY r.tenant_name NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  OFFSET greatest(0, coalesce(p_offset, 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.correct_tenant_location(
  p_tenant_id uuid,
  p_village_id integer,
  p_reason text DEFAULT 'Legacy location corrected to the approved Uganda location dataset'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_is_ops boolean;
  v_is_agent boolean;
  v_chain record;
  v_old jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_village_id IS NULL THEN
    RAISE EXCEPTION 'An approved village must be selected';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  v_is_ops := public.is_ops_role(v_actor);
  v_is_agent := EXISTS (
    SELECT 1 FROM public.rent_requests r
    WHERE r.tenant_id = p_tenant_id
      AND (r.agent_id = v_actor OR r.assigned_agent_id = v_actor)
  ) OR public.has_agent_contact_relationship(v_actor, p_tenant_id);

  IF NOT (v_is_ops OR v_is_agent) THEN
    RAISE EXCEPTION 'Not authorised to correct this tenant';
  END IF;

  SELECT v.id AS village_id, v.name AS village, pa.name AS parish, sc.name AS subcounty,
         c.name AS county, d.name AS district, d.region AS region
  INTO v_chain
  FROM public.ug_villages v
  JOIN public.ug_parishes pa ON pa.id = v.parish_id
  JOIN public.ug_subcounties sc ON sc.id = pa.subcounty_id
  JOIN public.ug_counties c ON c.id = sc.county_id
  JOIN public.ug_districts d ON d.id = c.district_id
  WHERE v.id = p_village_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Village % is not in the approved location dataset', p_village_id;
  END IF;

  SELECT jsonb_build_object(
    'region', p.region, 'district', p.district, 'sub_county', p.sub_county,
    'parish', p.parish, 'village', p.village, 'ug_village_id', p.ug_village_id
  ) INTO v_old
  FROM public.profiles p WHERE p.id = p_tenant_id;

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;

  UPDATE public.profiles SET
    ug_village_id = v_chain.village_id,
    village = v_chain.village,
    parish = v_chain.parish,
    sub_county = v_chain.subcounty,
    district = v_chain.district,
    region = coalesce(v_chain.region, region),
    address_complete = true,
    address_completed_at = coalesce(address_completed_at, now()),
    updated_at = now()
  WHERE id = p_tenant_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_actor, 'tenant.location_corrected', 'profiles', p_tenant_id::text, btrim(p_reason),
    jsonb_build_object(
      'reason', p_reason,
      'is_ops', v_is_ops,
      'is_agent', v_is_agent,
      'previous', v_old,
      'corrected', jsonb_build_object(
        'ug_village_id', v_chain.village_id,
        'village', v_chain.village,
        'parish', v_chain.parish,
        'sub_county', v_chain.subcounty,
        'district', v_chain.district,
        'region', v_chain.region
      )
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'tenant_id', p_tenant_id,
    'ug_village_id', v_chain.village_id,
    'full_path', concat_ws(', ', v_chain.village, v_chain.parish, v_chain.subcounty, v_chain.county, v_chain.district)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_location_corrections(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_location_correction_progress(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.correct_tenant_location(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_location_corrections(uuid, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_location_correction_progress(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.correct_tenant_location(uuid, integer, text) TO authenticated;