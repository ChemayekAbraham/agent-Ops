CREATE OR REPLACE FUNCTION public.assert_agent_collections_report_access()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN true;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF public.has_role(v_uid, 'agent_ops')
     OR public.has_role(v_uid, 'operations')
     OR public.has_role(v_uid, 'coo')
     OR public.has_role(v_uid, 'ceo')
     OR public.has_role(v_uid, 'cfo')
     OR public.has_role(v_uid, 'manager')
     OR public.has_role(v_uid, 'super_admin') THEN
    RETURN true;
  END IF;
  RAISE EXCEPTION 'Not authorized: daily rent collections reporting is restricted to Agent Ops and leadership';
END;
$$;

REVOKE ALL ON FUNCTION public.assert_agent_collections_report_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_agent_collections_report_access() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.agent_daily_collections_overview(
  p_from date,
  p_to date,
  p_forecast boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from date := least(coalesce(p_from, current_date), coalesce(p_to, current_date));
  v_to date := greatest(coalesce(p_from, current_date), coalesce(p_to, current_date));
  v_days integer;
  v_result jsonb;
BEGIN
  PERFORM public.assert_agent_collections_report_access();
  v_days := greatest(1, (v_to - v_from) + 1);

  IF p_forecast THEN
    -- Forward-looking: no collections exist yet, so every figure comes from the
    -- active repaying plans themselves.
    WITH plans AS (
      SELECT rr.id AS rent_request_id,
             rr.agent_id,
             rr.tenant_id,
             rr.landlord_id,
             rr.house_listing_id,
             coalesce(rr.daily_repayment, 0)::numeric AS daily_repayment,
             greatest(0, coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0))::numeric AS outstanding
        FROM public.rent_requests rr
       WHERE rr.status IN ('funded', 'repaying')
         AND rr.agent_id IS NOT NULL
         AND coalesce(rr.daily_repayment, 0) > 0
    ), lines AS (
      SELECT p.*,
             coalesce(pa.full_name, 'Agent') AS agent_name,
             coalesce(pt.full_name, 'Tenant') AS tenant_name,
             pt.phone AS tenant_phone,
             coalesce(l.full_name, '—') AS landlord_name,
             coalesce(nullif(btrim(coalesce(h.address, '')), ''),
                      nullif(btrim(coalesce(h.title, '')), ''),
                      nullif(btrim(coalesce(h.district, '')), ''),
                      '—') AS address,
             coalesce(nullif(btrim(coalesce(h.district, '')), ''),
                      nullif(btrim(coalesce(h.region, '')), ''),
                      nullif(btrim(coalesce(h.address, '')), ''),
                      '—') AS area,
             (p.daily_repayment * v_days) AS expected
        FROM plans p
        LEFT JOIN public.profiles pa ON pa.id = p.agent_id
        LEFT JOIN public.profiles pt ON pt.id = p.tenant_id
        LEFT JOIN public.landlords l ON l.id = p.landlord_id
        LEFT JOIN public.house_listings h ON h.id = p.house_listing_id
    )
    SELECT jsonb_build_object(
      'mode', 'forecast',
      'from', v_from,
      'to', v_to,
      'days', v_days,
      'kpis', (SELECT jsonb_build_object(
                 'total_collected', 0,
                 'total_expected', coalesce(sum(expected), 0),
                 'tenants_count', count(DISTINCT tenant_id),
                 'agents_count', count(DISTINCT agent_id),
                 'areas_count', count(DISTINCT area) FILTER (WHERE area <> '—')
               ) FROM lines),
      'agents', coalesce((SELECT jsonb_agg(a ORDER BY (a->>'expected')::numeric DESC)
                            FROM (SELECT jsonb_build_object(
                                    'agent_id', agent_id,
                                    'agent_name', agent_name,
                                    'collected', 0,
                                    'expected', sum(expected),
                                    'tenants', count(DISTINCT tenant_id),
                                    'payments', 0,
                                    'success_rate', 0
                                  ) AS a
                                    FROM lines GROUP BY agent_id, agent_name) s), '[]'::jsonb),
      'rows', coalesce((SELECT jsonb_agg(r ORDER BY (r->>'expected')::numeric DESC)
                          FROM (SELECT jsonb_build_object(
                                  'key', rent_request_id,
                                  'agent_id', agent_id,
                                  'agent_name', agent_name,
                                  'tenant_id', tenant_id,
                                  'tenant_name', tenant_name,
                                  'tenant_phone', tenant_phone,
                                  'address', address,
                                  'area', area,
                                  'landlord_name', landlord_name,
                                  'collected', 0,
                                  'expected', expected,
                                  'remaining', expected,
                                  'balance', outstanding,
                                  'payments', 0,
                                  'last_collected_at', NULL
                                ) AS r
                                  FROM lines LIMIT 1000) s), '[]'::jsonb),
      'top_agents', coalesce((SELECT jsonb_agg(t ORDER BY (t->>'expected')::numeric DESC)
                               FROM (SELECT jsonb_build_object(
                                       'agent_id', agent_id,
                                       'agent_name', agent_name,
                                       'collected', 0,
                                       'expected', sum(expected),
                                       'payments', 0,
                                       'success_rate', 0
                                     ) AS t
                                       FROM lines GROUP BY agent_id, agent_name
                                       ORDER BY sum(expected) DESC LIMIT 12) s), '[]'::jsonb)
    ) INTO v_result;

    RETURN v_result;
  END IF;

  -- Actuals: collections inside the window that belong to an active repaying plan.
  WITH src AS (
    SELECT ac.id,
           ac.agent_id,
           ac.tenant_id,
           ac.rent_request_id,
           coalesce(ac.amount, 0)::numeric AS amount,
           ac.expected_amount,
           ac.created_at,
           ac.location_name,
           rr.landlord_id,
           rr.house_listing_id,
           coalesce(rr.daily_repayment, 0)::numeric AS daily_repayment,
           greatest(0, coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0))::numeric AS outstanding
      FROM public.agent_collections ac
      JOIN public.rent_requests rr ON rr.id = ac.rent_request_id
     WHERE ac.created_at >= v_from::timestamp
       AND ac.created_at < (v_to + 1)::timestamp
       AND ac.agent_id IS NOT NULL
       AND rr.status IN ('funded', 'repaying')
  ), grouped AS (
    SELECT s.agent_id,
           s.tenant_id,
           s.rent_request_id,
           sum(s.amount) AS collected,
           count(*) AS payments,
           max(s.created_at) AS last_collected_at,
           max(s.daily_repayment) AS daily_repayment,
           max(s.outstanding) AS outstanding,
           max(s.landlord_id) AS landlord_id,
           max(s.house_listing_id) AS house_listing_id,
           max(s.location_name) AS location_name
      FROM src s
     GROUP BY s.agent_id, s.tenant_id, s.rent_request_id
  ), lines AS (
    SELECT g.*,
           coalesce(pa.full_name, 'Agent') AS agent_name,
           coalesce(pt.full_name, 'Tenant') AS tenant_name,
           pt.phone AS tenant_phone,
           coalesce(l.full_name, '—') AS landlord_name,
           coalesce(nullif(btrim(coalesce(h.address, '')), ''),
                    nullif(btrim(coalesce(h.title, '')), ''),
                    nullif(btrim(coalesce(g.location_name, '')), ''),
                    '—') AS address,
           coalesce(nullif(btrim(coalesce(h.district, '')), ''),
                    nullif(btrim(coalesce(h.region, '')), ''),
                    nullif(btrim(coalesce(h.address, '')), ''),
                    nullif(btrim(coalesce(g.location_name, '')), ''),
                    '—') AS area,
           (g.daily_repayment * v_days) AS expected
      FROM grouped g
      LEFT JOIN public.profiles pa ON pa.id = g.agent_id
      LEFT JOIN public.profiles pt ON pt.id = g.tenant_id
      LEFT JOIN public.landlords l ON l.id = g.landlord_id
      LEFT JOIN public.house_listings h ON h.id = g.house_listing_id
  )
  SELECT jsonb_build_object(
    'mode', 'actual',
    'from', v_from,
    'to', v_to,
    'days', v_days,
    'kpis', (SELECT jsonb_build_object(
               'total_collected', coalesce(sum(collected), 0),
               'total_expected', coalesce(sum(expected), 0),
               'tenants_count', count(DISTINCT tenant_id),
               'agents_count', count(DISTINCT agent_id),
               'areas_count', count(DISTINCT area) FILTER (WHERE area <> '—')
             ) FROM lines),
    'agents', coalesce((SELECT jsonb_agg(a ORDER BY (a->>'collected')::numeric DESC)
                          FROM (SELECT jsonb_build_object(
                                  'agent_id', agent_id,
                                  'agent_name', agent_name,
                                  'collected', sum(collected),
                                  'expected', sum(expected),
                                  'tenants', count(DISTINCT tenant_id),
                                  'payments', sum(payments),
                                  'success_rate', CASE WHEN sum(expected) > 0
                                                       THEN round(least(100, (sum(collected) / sum(expected)) * 100), 1)
                                                       ELSE 0 END
                                ) AS a
                                  FROM lines GROUP BY agent_id, agent_name) s), '[]'::jsonb),
    'rows', coalesce((SELECT jsonb_agg(r ORDER BY (r->>'collected')::numeric DESC)
                        FROM (SELECT jsonb_build_object(
                                'key', coalesce(rent_request_id::text, tenant_id::text),
                                'agent_id', agent_id,
                                'agent_name', agent_name,
                                'tenant_id', tenant_id,
                                'tenant_name', tenant_name,
                                'tenant_phone', tenant_phone,
                                'address', address,
                                'area', area,
                                'landlord_name', landlord_name,
                                'collected', collected,
                                'expected', expected,
                                'remaining', greatest(0, expected - collected),
                                'balance', outstanding,
                                'payments', payments,
                                'last_collected_at', last_collected_at
                              ) AS r
                                FROM lines ORDER BY collected DESC LIMIT 1000) s), '[]'::jsonb),
    'top_agents', coalesce((SELECT jsonb_agg(t ORDER BY (t->>'collected')::numeric DESC)
                             FROM (SELECT jsonb_build_object(
                                     'agent_id', agent_id,
                                     'agent_name', agent_name,
                                     'collected', sum(collected),
                                     'expected', sum(expected),
                                     'payments', sum(payments),
                                     'success_rate', CASE WHEN sum(expected) > 0
                                                          THEN round(least(100, (sum(collected) / sum(expected)) * 100), 1)
                                                          ELSE 0 END
                                   ) AS t
                                     FROM lines GROUP BY agent_id, agent_name
                                     ORDER BY sum(collected) DESC LIMIT 12) s), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_daily_collections_overview(date, date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_daily_collections_overview(date, date, boolean) TO authenticated, service_role;