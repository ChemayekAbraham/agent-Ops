-- Read-only daily pipeline trend for Tenant Ops → Classic → Home.
-- Every series reuses the EXISTING authoritative source/date stamp:
--   registrations     v_tenant_ops_tenant_base.tenant_created_at  (same as get_tenant_ops_acquisition)
--   applications      rent_requests.created_at
--   coo_approved      rent_requests.coo_reviewed_at
--   cfo_funded        rent_requests.funded_at     (stamped by fund-agent-landlord-float)
--   landlord_funded   landlord_payouts.disbursed_at (same as get_tenant_location_breakdown)
--   rejected          rent_requests.rejected_at
-- Days are bucketed in Africa/Kampala and zero-filled with generate_series.
CREATE OR REPLACE FUNCTION public.get_tenant_ops_pipeline_trend(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 7), 180);
  v_start date;
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

  v_start := v_today - (v_days - 1);

  RETURN (
    WITH days AS (
      SELECT g.day::date AS d
      FROM generate_series(v_start, v_today, interval '1 day') AS g(day)
    ),
    reg AS (
      SELECT (b.tenant_created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS c
      FROM public.v_tenant_ops_tenant_base b
      WHERE b.tenant_created_at >= v_start
      GROUP BY 1
    ),
    apps AS (
      SELECT (r.created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS c
      FROM public.rent_requests r
      WHERE r.created_at >= v_start
      GROUP BY 1
    ),
    coo AS (
      SELECT (r.coo_reviewed_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS c
      FROM public.rent_requests r
      WHERE r.coo_reviewed_at >= v_start
      GROUP BY 1
    ),
    cfo AS (
      SELECT (r.funded_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS c
      FROM public.rent_requests r
      WHERE r.funded_at >= v_start
      GROUP BY 1
    ),
    ll AS (
      SELECT (lp.disbursed_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS c
      FROM public.landlord_payouts lp
      WHERE lp.disbursed_at >= v_start
      GROUP BY 1
    ),
    rej AS (
      SELECT (r.rejected_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS c
      FROM public.rent_requests r
      WHERE r.rejected_at >= v_start
      GROUP BY 1
    )
    SELECT jsonb_build_object(
      'days', v_days,
      'start', v_start,
      'end', v_today,
      'series', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'date', d.d,
            'registrations', COALESCE(reg.c, 0),
            'applications', COALESCE(apps.c, 0),
            'coo_approved', COALESCE(coo.c, 0),
            'cfo_funded', COALESCE(cfo.c, 0),
            'landlord_funded', COALESCE(ll.c, 0),
            'rejected', COALESCE(rej.c, 0)
          ) ORDER BY d.d
        )
        FROM days d
        LEFT JOIN reg  ON reg.d  = d.d
        LEFT JOIN apps ON apps.d = d.d
        LEFT JOIN coo  ON coo.d  = d.d
        LEFT JOIN cfo  ON cfo.d  = d.d
        LEFT JOIN ll   ON ll.d   = d.d
        LEFT JOIN rej  ON rej.d  = d.d
      ), '[]'::jsonb)
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_tenant_ops_pipeline_trend(integer) TO authenticated;