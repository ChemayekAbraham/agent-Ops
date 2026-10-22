-- Dashboard Access view (CTO and HR dashboards): read side.
--
-- get_dashboard_access_overview(): every active allowlist grant with names,
-- plus the staff who hold a role that works from a dashboard but are NOT on
-- that dashboard's list (the people the 20261021180000 allowlist locks out).
-- search_people_for_dashboard_access(term): find someone to grant.
--
-- Both are callable only by super_admin, cto or hr
-- (can_manage_dashboard_access). Writes stay in grant_dashboard_access /
-- revoke_dashboard_access.

-- Staff role -> dashboard key. Must match ROLE_DASHBOARD_KEY in
-- src/hooks/useStaffPermissions.ts.
CREATE OR REPLACE FUNCTION public.dashboard_key_for_role(p_role text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_role
    WHEN 'ceo' THEN 'ceo'
    WHEN 'coo' THEN 'coo'
    WHEN 'cfo' THEN 'cfo'
    WHEN 'cmo' THEN 'cmo'
    WHEN 'crm' THEN 'crm'
    WHEN 'hr' THEN 'hr'
    WHEN 'rd' THEN 'rd'
    WHEN 'manager' THEN 'company-ops'
    WHEN 'operations' THEN 'company-ops'
    WHEN 'financial_ops' THEN 'financial-ops'
    WHEN 'agent_ops' THEN 'agent-ops'
    WHEN 'tenant_ops' THEN 'tenant-ops'
    WHEN 'landlord_ops' THEN 'landlord-ops'
    WHEN 'partner_ops' THEN 'partner-ops'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.get_dashboard_access_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_grants jsonb;
  v_missing jsonb;
BEGIN
  IF v_actor IS NULL OR NOT public.can_manage_dashboard_access(v_actor) THEN
    RAISE EXCEPTION 'Only super_admin, CTO or HR can view dashboard access' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'grant_id', sp.id,
           'user_id', sp.user_id,
           'full_name', p.full_name,
           'phone', p.phone,
           'dashboard', sp.permitted_dashboard,
           'granted_at', sp.granted_at,
           'granted_by', sp.granted_by,
           'granted_by_name', gb.full_name
         ) ORDER BY sp.permitted_dashboard, p.full_name), '[]'::jsonb)
    INTO v_grants
  FROM public.staff_permissions sp
  LEFT JOIN public.profiles p ON p.id = sp.user_id
  LEFT JOIN public.profiles gb ON gb.id = sp.granted_by
  WHERE sp.revoked_at IS NULL;

  -- Role holders not on their dashboard's list. super_admin/cto holders are
  -- left out: they bypass the allowlist.
  -- One row per person per dashboard (manager and operations both map to
  -- company-ops), with the roles that point them there.
  WITH holders AS (
    SELECT ur.user_id, public.dashboard_key_for_role(ur.role::text) AS dashboard,
           array_agg(DISTINCT ur.role::text ORDER BY ur.role::text) AS roles
    FROM public.user_roles ur
    WHERE ur.enabled = true
      AND public.dashboard_key_for_role(ur.role::text) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles b
        WHERE b.user_id = ur.user_id AND b.enabled = true AND b.role IN ('super_admin', 'cto')
      )
    GROUP BY ur.user_id, public.dashboard_key_for_role(ur.role::text)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'user_id', h.user_id,
           'full_name', p.full_name,
           'phone', p.phone,
           'roles', to_jsonb(h.roles),
           'dashboard', h.dashboard
         ) ORDER BY h.dashboard, p.full_name), '[]'::jsonb)
    INTO v_missing
  FROM holders h
  LEFT JOIN public.profiles p ON p.id = h.user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.staff_permissions sp
    WHERE sp.user_id = h.user_id AND sp.permitted_dashboard = h.dashboard AND sp.revoked_at IS NULL
  );

  RETURN jsonb_build_object(
    'generated_at', now(),
    'keys', to_jsonb(public.dashboard_access_keys()),
    'grants', v_grants,
    'missing', v_missing
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_people_for_dashboard_access(p_term text)
 RETURNS TABLE(id uuid, full_name text, phone text, email text, roles text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t text := lower(btrim(coalesce(p_term, '')));
  words text;
  q text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_dashboard_access(auth.uid()) THEN
    RAISE EXCEPTION 'Only super_admin, CTO or HR can search for dashboard access' USING ERRCODE = '42501';
  END IF;
  IF length(t) < 2 THEN
    RETURN;
  END IF;

  words := btrim(regexp_replace(t, '[^a-z0-9]+', ' ', 'g'));
  q := CASE WHEN length(words) > 0 THEN regexp_replace(words, '\s+', ':* & ', 'g') || ':*' END;

  RETURN QUERY
    SELECT p.id, p.full_name, p.phone, p.email,
           coalesce((SELECT array_agg(ur.role::text ORDER BY ur.role::text)
                     FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.enabled = true), '{}'::text[])
    FROM public.profiles p
    WHERE coalesce(p.full_name, '') NOT LIKE '[DELETED]%'
      AND ((q IS NOT NULL AND to_tsvector('simple', coalesce(p.full_name, '')) @@ to_tsquery('simple', q))
           OR lower(p.email) LIKE t || '%'
           OR p.phone LIKE t || '%')
    ORDER BY p.full_name
    LIMIT 25;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_dashboard_access_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_people_for_dashboard_access(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_access_overview() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_people_for_dashboard_access(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dashboard_key_for_role(text) TO authenticated, service_role;
