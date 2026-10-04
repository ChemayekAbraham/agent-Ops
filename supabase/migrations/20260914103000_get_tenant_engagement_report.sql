-- useTenantEngagementReport calls get_tenant_engagement_report, which never
-- existed. The hook has no current call site anywhere in src/ -- it was
-- built ahead of whatever UI was meant to use it -- but its own docstring
-- is a complete spec: "Cross-references profiles.has_smartphone with
-- profiles.last_active_at so Tenant Ops can see who owns a smartphone but
-- isn't using their dashboard — the gap flagged in the 2026-09-06
-- tenant-ops meeting."
--
-- Population is every profile with a non-null tenant_status (95,806 rows,
-- matching the tenant-role count almost exactly). Same auth gate as the
-- rest of the Tenant Ops surface (is_tenant_ops_staff, e.g. ops_tenant_inbox).
-- Default order surfaces the exact gap the docstring names: smartphone
-- owners who have gone longest without activity first.

CREATE OR REPLACE FUNCTION public.get_tenant_engagement_report(
  p_limit integer DEFAULT 200,
  p_offset integer DEFAULT 0,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_summary jsonb;
  v_rows jsonb;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT jsonb_build_object(
    'tenants', count(*),
    'with_smartphone', count(*) FILTER (WHERE p.has_smartphone),
    'without_smartphone', count(*) FILTER (WHERE NOT p.has_smartphone),
    'never_active', count(*) FILTER (WHERE p.last_active_at IS NULL),
    'inactive_30d', count(*) FILTER (WHERE p.last_active_at IS NOT NULL AND p.last_active_at < now() - interval '30 days'),
    'generated_at', now()
  )
  INTO v_summary
  FROM public.profiles p
  WHERE p.tenant_status IS NOT NULL
    AND (
      v_q IS NULL
      OR p.full_name ILIKE '%' || v_q || '%'
      OR p.phone ILIKE '%' || v_q || '%'
    );

  SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      p.id AS tenant_id,
      p.full_name,
      p.phone,
      p.has_smartphone,
      p.last_active_at,
      p.tenant_status,
      CASE WHEN p.last_active_at IS NULL THEN NULL
           ELSE EXTRACT(day FROM now() - p.last_active_at)::int END AS days_since_active
    FROM public.profiles p
    WHERE p.tenant_status IS NOT NULL
      AND (
        v_q IS NULL
        OR p.full_name ILIKE '%' || v_q || '%'
        OR p.phone ILIKE '%' || v_q || '%'
      )
    ORDER BY p.has_smartphone DESC, p.last_active_at ASC NULLS FIRST
    LIMIT greatest(1, least(coalesce(p_limit, 200), 500))
    OFFSET greatest(0, coalesce(p_offset, 0))
  ) t;

  RETURN jsonb_build_object('summary', v_summary, 'rows', v_rows);
END;
$function$;
