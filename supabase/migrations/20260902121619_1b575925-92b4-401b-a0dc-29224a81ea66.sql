CREATE OR REPLACE FUNCTION public.get_tenant_ops_acquisition_range(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start date := (p_start AT TIME ZONE 'Africa/Kampala')::date;
  v_end date := (p_end AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN (
    WITH t AS (
      SELECT (b.tenant_created_at AT TIME ZONE 'Africa/Kampala')::date AS d
      FROM public.v_tenant_ops_tenant_base b
      WHERE b.tenant_created_at IS NOT NULL
        AND (b.tenant_created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_start AND v_end
    )
    SELECT jsonb_build_object(
      'new_tenants', (SELECT count(*) FROM t),
      'trend', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('date', g.day, 'count', COALESCE(x.c, 0)) ORDER BY g.day)
        FROM generate_series(v_start, v_end, interval '1 day') AS g(day)
        LEFT JOIN (SELECT d, count(*) AS c FROM t GROUP BY d) x ON x.d = g.day::date
        WHERE (v_end - v_start) <= 400
      ), '[]'::jsonb)
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_tenant_ops_acquisition_range(timestamptz, timestamptz) TO authenticated;