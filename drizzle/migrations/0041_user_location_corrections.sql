-- 1. Allow a user to correct their OWN profile location, reusing the existing
--    tenant correction write path (same dataset, same audit trail, location only).
CREATE OR REPLACE FUNCTION public.correct_tenant_location(p_tenant_id uuid, p_village_id integer, p_reason text DEFAULT 'Legacy location corrected to the approved Uganda location dataset'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_ops boolean;
  v_is_agent boolean;
  v_is_self boolean;
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

  v_is_self := (v_actor = p_tenant_id);
  v_is_ops := public.is_ops_role(v_actor);
  v_is_agent := EXISTS (
    SELECT 1 FROM public.rent_requests r
    WHERE r.tenant_id = p_tenant_id
      AND (r.agent_id = v_actor OR r.assigned_agent_id = v_actor)
  ) OR public.has_agent_contact_relationship(v_actor, p_tenant_id);

  IF NOT (v_is_self OR v_is_ops OR v_is_agent) THEN
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
      'is_self', v_is_self,
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
$function$;

-- 2. Self status for the login prompt. Any authenticated caller, own row only.
CREATE OR REPLACE FUNCTION public.my_location_correction_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_p record;
  v_is_tenant boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT p.id, p.full_name, p.phone, p.ug_village_id, p.region, p.district,
         p.sub_county, p.parish, p.village
  INTO v_p
  FROM public.profiles p WHERE p.id = v_actor;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('needs_correction', false, 'is_tenant', false);
  END IF;

  v_is_tenant := EXISTS (SELECT 1 FROM public.rent_requests r WHERE r.tenant_id = v_actor);

  RETURN jsonb_build_object(
    'user_id', v_p.id,
    'full_name', v_p.full_name,
    'phone', v_p.phone,
    'needs_correction', v_p.ug_village_id IS NULL,
    'is_tenant', v_is_tenant,
    'ug_village_id', v_p.ug_village_id,
    'legacy_region', v_p.region,
    'legacy_district', v_p.district,
    'legacy_sub_county', v_p.sub_county,
    'legacy_parish', v_p.parish,
    'legacy_village', v_p.village,
    'roles', coalesce((
      SELECT array_agg(ur.role::text ORDER BY ur.role::text)
      FROM public.user_roles ur
      WHERE ur.user_id = v_actor AND coalesce(ur.enabled, true)
    ), ARRAY[]::text[])
  );
END;
$function$;

-- 3. Ops monitoring: every authenticated system user (a profile with at least one
--    enabled role), their location state and the correction record if any.
CREATE OR REPLACE FUNCTION public.user_location_corrections(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
 RETURNS TABLE(
   user_id uuid, full_name text, phone text, roles text[], is_tenant boolean,
   legacy_region text, legacy_district text, legacy_sub_county text,
   legacy_parish text, legacy_village text,
   ug_village_id integer, approved_path text,
   correction_status text, corrected_at timestamp with time zone,
   corrected_by uuid, corrected_by_name text, total_count bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_q text := NULLIF(btrim(coalesce(p_search, '')), '');
  v_status text := NULLIF(lower(btrim(coalesce(p_status, ''))), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  RETURN QUERY
  WITH users AS (
    SELECT p.id, p.full_name, p.phone, p.ug_village_id,
           p.region, p.district, p.sub_county, p.parish, p.village,
           (SELECT array_agg(DISTINCT ur.role::text)
              FROM public.user_roles ur
             WHERE ur.user_id = p.id AND coalesce(ur.enabled, true)) AS roles
    FROM public.profiles p
    WHERE EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = p.id AND coalesce(ur.enabled, true)
    )
  ), enriched AS (
    SELECT
      u.id AS user_id, u.full_name, u.phone, coalesce(u.roles, ARRAY[]::text[]) AS roles,
      EXISTS (SELECT 1 FROM public.rent_requests r WHERE r.tenant_id = u.id) AS is_tenant,
      u.region AS legacy_region, u.district AS legacy_district,
      u.sub_county AS legacy_sub_county, u.parish AS legacy_parish, u.village AS legacy_village,
      u.ug_village_id,
      CASE WHEN u.ug_village_id IS NULL THEN NULL
           ELSE concat_ws(', ', u.village, u.parish, u.sub_county, u.district, u.region) END AS approved_path,
      CASE
        WHEN u.ug_village_id IS NOT NULL THEN 'corrected'
        WHEN coalesce(btrim(coalesce(u.village, '') || coalesce(u.parish, '') || coalesce(u.sub_county, '')
                            || coalesce(u.district, '') || coalesce(u.region, '')), '') <> '' THEN 'pending'
        ELSE 'unmapped'
      END AS correction_status,
      a.created_at AS corrected_at,
      a.user_id AS corrected_by,
      ap.full_name AS corrected_by_name
    FROM users u
    LEFT JOIN LATERAL (
      SELECT al.created_at, al.user_id
      FROM public.audit_logs al
      WHERE al.action_type = 'tenant.location_corrected'
        AND al.table_name = 'profiles'
        AND al.record_id = u.id::text
      ORDER BY al.created_at DESC
      LIMIT 1
    ) a ON true
    LEFT JOIN public.profiles ap ON ap.id = a.user_id
  ), filtered AS (
    SELECT * FROM enriched e
    WHERE (v_status IS NULL OR e.correction_status = v_status)
      AND (
        v_q IS NULL
        OR coalesce(e.full_name, '') ILIKE '%' || v_q || '%'
        OR coalesce(e.phone, '') ILIKE '%' || v_q || '%'
        OR coalesce(e.legacy_district, '') ILIKE '%' || v_q || '%'
        OR coalesce(e.legacy_village, '') ILIKE '%' || v_q || '%'
        OR array_to_string(e.roles, ' ') ILIKE '%' || v_q || '%'
      )
  )
  SELECT f.*, count(*) OVER ()::bigint AS total_count
  FROM filtered f
  ORDER BY CASE f.correction_status WHEN 'unmapped' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
           f.full_name NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  OFFSET greatest(0, coalesce(p_offset, 0));
END;
$function$;

-- 4. Ops monitoring totals for the tab header.
CREATE OR REPLACE FUNCTION public.user_location_correction_progress()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  WITH users AS (
    SELECT p.id, p.ug_village_id, p.region, p.district, p.sub_county, p.parish, p.village
    FROM public.profiles p
    WHERE EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = p.id AND coalesce(ur.enabled, true)
    )
  ), s AS (
    SELECT
      CASE
        WHEN u.ug_village_id IS NOT NULL THEN 'corrected'
        WHEN coalesce(btrim(coalesce(u.village, '') || coalesce(u.parish, '') || coalesce(u.sub_county, '')
                            || coalesce(u.district, '') || coalesce(u.region, '')), '') <> '' THEN 'pending'
        ELSE 'unmapped'
      END AS st,
      EXISTS (SELECT 1 FROM public.rent_requests r WHERE r.tenant_id = u.id) AS is_tenant
    FROM users u
  )
  SELECT jsonb_build_object(
    'total_users', count(*),
    'corrected', count(*) FILTER (WHERE st = 'corrected'),
    'pending', count(*) FILTER (WHERE st = 'pending'),
    'unmapped', count(*) FILTER (WHERE st = 'unmapped'),
    'outstanding', count(*) FILTER (WHERE st <> 'corrected'),
    'also_tenants', count(*) FILTER (WHERE is_tenant),
    'also_tenants_outstanding', count(*) FILTER (WHERE is_tenant AND st <> 'corrected')
  ) INTO v_out FROM s;

  RETURN coalesce(v_out, '{}'::jsonb);
END;
$function$;