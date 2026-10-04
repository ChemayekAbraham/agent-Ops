DROP FUNCTION IF EXISTS public.get_platform_user_counts();
CREATE OR REPLACE FUNCTION public.get_platform_user_counts()
 RETURNS TABLE(total_users bigint, verified_users bigint, inactive_users bigint, tenant_count bigint, agent_count bigint, supporter_count bigint, landlord_count bigint, manager_count bigint, super_admin_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_platform_user_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not allowed to view platform users';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.profiles)::bigint AS total_users,
    (SELECT count(*) FROM public.profiles WHERE verified IS TRUE)::bigint AS verified_users,
    (SELECT count(*) FROM public.profiles WHERE last_active_at IS NULL OR last_active_at < now() - interval '30 days')::bigint AS inactive_users,
    (SELECT count(*) FROM public.user_roles WHERE role = 'tenant'::public.app_role AND enabled IS TRUE)::bigint AS tenant_count,
    (SELECT count(*) FROM public.user_roles WHERE role = 'agent'::public.app_role AND enabled IS TRUE)::bigint AS agent_count,
    (SELECT count(*) FROM public.user_roles WHERE role = 'supporter'::public.app_role AND enabled IS TRUE)::bigint AS supporter_count,
    (SELECT count(*) FROM public.user_roles WHERE role = 'landlord'::public.app_role AND enabled IS TRUE)::bigint AS landlord_count,
    (SELECT count(*) FROM public.user_roles WHERE role = 'manager'::public.app_role AND enabled IS TRUE)::bigint AS manager_count,
    (SELECT count(*) FROM public.user_roles WHERE role = 'super_admin'::public.app_role AND enabled IS TRUE)::bigint AS super_admin_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_platform_users_page(_search text DEFAULT ''::text, _role_filter text DEFAULT 'all'::text, _verification_filter text DEFAULT 'all'::text, _stat_filter text DEFAULT 'all'::text, _sort text DEFAULT 'newest'::text, _limit integer DEFAULT 25, _offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, full_name text, email text, phone text, avatar_url text, rent_discount_active boolean, monthly_rent numeric, created_at timestamp with time zone, country text, city text, country_code text, verified boolean, last_active_at timestamp with time zone, roles text[], role_enabled_status jsonb, average_rating numeric, rating_count integer, subagent_count integer, total_matched bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(_limit, 25), 1), 100);
  v_offset integer := GREATEST(COALESCE(_offset, 0), 0);
  v_search text := NULLIF(trim(COALESCE(_search, '')), '');
  v_role text := COALESCE(NULLIF(_role_filter, ''), 'all');
  v_verification text := COALESCE(NULLIF(_verification_filter, ''), 'all');
  v_stat text := COALESCE(NULLIF(_stat_filter, ''), 'all');
  v_sort text := COALESCE(NULLIF(_sort, ''), 'newest');
BEGIN
  IF NOT public.is_platform_user_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not allowed to view platform users';
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT p.*
    FROM public.profiles p
    WHERE
      (
        v_search IS NULL
        OR p.full_name ILIKE ('%' || v_search || '%')
        OR p.email ILIKE ('%' || v_search || '%')
        OR p.phone ILIKE ('%' || v_search || '%')
      )
      AND (
        v_verification = 'all'
        OR (v_verification = 'verified' AND p.verified IS TRUE)
        OR (v_verification = 'pending' AND COALESCE(p.verified, false) IS FALSE)
      )
      AND (
        v_stat NOT IN ('inactive')
        OR p.last_active_at IS NULL
        OR p.last_active_at < now() - interval '30 days'
      )
      AND (
        v_role NOT IN ('tenant', 'agent', 'supporter', 'landlord', 'manager', 'super_admin')
        OR EXISTS (
          SELECT 1
          FROM public.user_roles urf
          WHERE urf.user_id = p.id
            AND urf.enabled IS TRUE
            AND urf.role::text = v_role
        )
      )
  ), counted AS (
    SELECT f.*, count(*) OVER() AS total_matched
    FROM filtered f
  ), page_rows AS (
    SELECT c.*
    FROM counted c
    ORDER BY
      CASE WHEN v_sort = 'newest' THEN c.created_at END DESC NULLS LAST,
      CASE WHEN v_sort = 'oldest' THEN c.created_at END ASC NULLS LAST,
      CASE WHEN v_sort = 'name_asc' THEN lower(c.full_name) END ASC NULLS LAST,
      CASE WHEN v_sort = 'name_desc' THEN lower(c.full_name) END DESC NULLS LAST,
      CASE WHEN v_sort = 'last_active' THEN c.last_active_at END DESC NULLS LAST,
      CASE WHEN v_sort = 'least_active' THEN c.last_active_at END ASC NULLS FIRST,
      c.created_at DESC NULLS LAST
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    pr.id,
    pr.full_name,
    pr.email,
    pr.phone,
    pr.avatar_url,
    COALESCE(pr.rent_discount_active, false) AS rent_discount_active,
    pr.monthly_rent,
    pr.created_at,
    pr.country,
    pr.city,
    pr.country_code,
    COALESCE(pr.verified, false) AS verified,
    pr.last_active_at,
    COALESCE(array_agg(ur.role::text) FILTER (WHERE ur.role IS NOT NULL AND ur.enabled IS TRUE), ARRAY[]::text[]) AS roles,
    COALESCE(jsonb_object_agg(ur.role::text, COALESCE(ur.enabled, false)) FILTER (WHERE ur.role IS NOT NULL), '{}'::jsonb) AS role_enabled_status,
    NULL::numeric AS average_rating,
    0::integer AS rating_count,
    0::integer AS subagent_count,
    max(pr.total_matched)::bigint AS total_matched
  FROM page_rows pr
  LEFT JOIN public.user_roles ur ON ur.user_id = pr.id
  GROUP BY
    pr.id, pr.full_name, pr.email, pr.phone, pr.avatar_url,
    pr.rent_discount_active, pr.monthly_rent, pr.created_at, pr.country,
    pr.city, pr.country_code, pr.verified, pr.last_active_at, pr.total_matched
  ORDER BY
    CASE WHEN v_sort = 'newest' THEN pr.created_at END DESC NULLS LAST,
    CASE WHEN v_sort = 'oldest' THEN pr.created_at END ASC NULLS LAST,
    CASE WHEN v_sort = 'name_asc' THEN lower(pr.full_name) END ASC NULLS LAST,
    CASE WHEN v_sort = 'name_desc' THEN lower(pr.full_name) END DESC NULLS LAST,
    CASE WHEN v_sort = 'last_active' THEN pr.last_active_at END DESC NULLS LAST,
    CASE WHEN v_sort = 'least_active' THEN pr.last_active_at END ASC NULLS FIRST,
    pr.created_at DESC NULLS LAST;
END;
$function$;