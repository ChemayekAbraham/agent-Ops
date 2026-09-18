-- Additive change to get_tenant_ops_acquisition(): adds a second 30-day daily
-- trend series, 'approved_trend', alongside the existing 'trend' (new tenant
-- registrations). Every existing key, calculation and the authorization check
-- are unchanged byte-for-byte.
--
-- "Approved" for this chart = rent_requests.funded_at IS NOT NULL, per explicit
-- product decision (2026-09-17): the single, unambiguous funding-event
-- timestamp, not a pipeline-stage status. This codebase has several other,
-- disagreeing "approved" definitions in use elsewhere (a pipeline-stage
-- approved_at timestamp, a 7/10-status list, a stage-review-timestamp union) —
-- do not reuse this key for those purposes, and do not change this definition
-- without the same sign-off.
CREATE OR REPLACE FUNCTION public.get_tenant_ops_acquisition()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_week_start date := date_trunc('week', (now() AT TIME ZONE 'Africa/Kampala')::date)::date;
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala')::date)::date;
  v_prev_month_start date := (date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala')::date) - interval '1 month')::date;
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
      WHERE b.tenant_created_at >= v_prev_month_start
    ),
    f AS (
      SELECT (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date AS d
      FROM public.rent_requests rr
      WHERE rr.funded_at >= v_today - 29
    )
    SELECT jsonb_build_object(
      'new_today', (SELECT count(*) FROM t WHERE d = v_today),
      'new_week', (SELECT count(*) FROM t WHERE d >= v_week_start),
      'new_month', (SELECT count(*) FROM t WHERE d >= v_month_start),
      'prev_month', (SELECT count(*) FROM t WHERE d >= v_prev_month_start AND d < v_month_start),
      'trend', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('date', g.day, 'count', COALESCE(x.c, 0)) ORDER BY g.day)
        FROM generate_series(v_today - 29, v_today, interval '1 day') AS g(day)
        LEFT JOIN (SELECT d, count(*) AS c FROM t WHERE d >= v_today - 29 GROUP BY d) x ON x.d = g.day::date
      ), '[]'::jsonb),
      'approved_trend', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('date', g.day, 'count', COALESCE(y.c, 0)) ORDER BY g.day)
        FROM generate_series(v_today - 29, v_today, interval '1 day') AS g(day)
        LEFT JOIN (SELECT d, count(*) AS c FROM f GROUP BY d) y ON y.d = g.day::date
      ), '[]'::jsonb)
    )
  );
END;
$function$;
