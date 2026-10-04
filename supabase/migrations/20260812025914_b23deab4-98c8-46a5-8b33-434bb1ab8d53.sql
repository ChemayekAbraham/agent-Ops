CREATE OR REPLACE FUNCTION public.ops_landlord_funded_stats(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to   timestamptz DEFAULT NULL,
  p_search    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
  v_span interval;
  v_prev_from timestamptz;
  v_prev_to   timestamptz;
  v_search text := nullif(btrim(coalesce(p_search,'')), '');
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'landlord_ops')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  v_to   := coalesce(p_date_to, now());
  v_from := coalesce(p_date_from, v_to - interval '30 days');
  v_span := v_to - v_from;
  v_prev_to   := v_from;
  v_prev_from := v_from - v_span;

  WITH funded AS (
    SELECT
      r.id,
      r.landlord_id,
      r.tenant_id,
      r.agent_id,
      r.funded_at,
      r.rent_amount,
      r.total_repayment,
      r.access_fee,
      r.request_fee,
      r.status,
      l.name  AS landlord_name,
      l.phone AS landlord_phone,
      l.verified AS landlord_verified,
      l.mobile_money_number,
      l.bank_name,
      coalesce(
        nullif(btrim(l.district), ''),
        nullif(btrim(tp.district), ''),
        nullif(btrim(hl.district), ''),
        'Unspecified'
      ) AS district,
      coalesce(
        nullif(btrim(l.region), ''),
        nullif(btrim(tp.region), ''),
        'Unspecified'
      ) AS region,
      tp.full_name AS tenant_name,
      coalesce(ap.full_name, 'Unassigned') AS agent_name,
      coalesce(sc.full_name, ap.full_name, 'Unassigned') AS service_centre
    FROM public.rent_requests r
    LEFT JOIN public.landlords l ON l.id = r.landlord_id
    LEFT JOIN public.profiles tp ON tp.id = r.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = r.agent_id
    LEFT JOIN LATERAL (
      SELECT h.district
      FROM public.house_listings h
      WHERE h.landlord_id = r.landlord_id
        AND nullif(btrim(h.district), '') IS NOT NULL
      LIMIT 1
    ) hl ON true
    LEFT JOIN LATERAL (
      SELECT pp.full_name
      FROM public.agent_subagents s
      JOIN public.profiles pp ON pp.id = s.parent_agent_id
      WHERE s.sub_agent_id = r.agent_id
        AND s.status = 'verified'
      ORDER BY s.created_at DESC
      LIMIT 1
    ) sc ON true
    WHERE r.funded_at IS NOT NULL
      AND r.landlord_id IS NOT NULL
      AND r.funded_at >= v_prev_from
      AND r.funded_at <  v_to
      AND (
        v_search IS NULL
        OR l.name ILIKE '%'||v_search||'%'
        OR l.phone ILIKE '%'||v_search||'%'
        OR tp.full_name ILIKE '%'||v_search||'%'
        OR ap.full_name ILIKE '%'||v_search||'%'
        OR l.district ILIKE '%'||v_search||'%'
      )
  ),
  cur AS (SELECT * FROM funded WHERE funded_at >= v_from AND funded_at < v_to),
  prev AS (SELECT * FROM funded WHERE funded_at >= v_prev_from AND funded_at < v_prev_to),
  first_ever AS (
    SELECT landlord_id, min(funded_at) AS first_funded_at
    FROM public.rent_requests
    WHERE funded_at IS NOT NULL AND landlord_id IS NOT NULL
    GROUP BY landlord_id
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object(
      'from', v_from, 'to', v_to,
      'previous_from', v_prev_from, 'previous_to', v_prev_to,
      'days', greatest(1, ceil(extract(epoch FROM v_span) / 86400.0))
    ),
    'summary', (
      SELECT jsonb_build_object(
        'landlords_funded', count(DISTINCT landlord_id),
        'requests_funded',  count(*),
        'total_funded',     coalesce(sum(rent_amount), 0),
        'total_repayment',  coalesce(sum(total_repayment), 0),
        'total_fees',       coalesce(sum(coalesce(access_fee,0) + coalesce(request_fee,0)), 0),
        'avg_per_landlord', CASE WHEN count(DISTINCT landlord_id) = 0 THEN 0
                                 ELSE round(coalesce(sum(rent_amount),0) / count(DISTINCT landlord_id), 0) END,
        'avg_per_request',  CASE WHEN count(*) = 0 THEN 0
                                 ELSE round(coalesce(sum(rent_amount),0) / count(*), 0) END,
        'verified_landlords', count(DISTINCT landlord_id) FILTER (WHERE landlord_verified),
        'unverified_landlords', count(DISTINCT landlord_id) FILTER (WHERE NOT coalesce(landlord_verified,false)),
        'with_momo', count(DISTINCT landlord_id) FILTER (WHERE nullif(btrim(coalesce(mobile_money_number,'')),'') IS NOT NULL),
        'with_bank', count(DISTINCT landlord_id) FILTER (WHERE nullif(btrim(coalesce(bank_name,'')),'') IS NOT NULL),
        'districts_covered', count(DISTINCT district),
        'agents_involved', count(DISTINCT agent_name) FILTER (WHERE agent_name <> 'Unassigned'),
        'first_time_landlords', count(DISTINCT c.landlord_id) FILTER (
          WHERE fe.first_funded_at >= v_from AND fe.first_funded_at < v_to),
        'repeat_landlords', count(DISTINCT c.landlord_id) FILTER (
          WHERE fe.first_funded_at < v_from)
      )
      FROM cur c LEFT JOIN first_ever fe ON fe.landlord_id = c.landlord_id
    ),
    'previous', (
      SELECT jsonb_build_object(
        'landlords_funded', count(DISTINCT landlord_id),
        'requests_funded',  count(*),
        'total_funded',     coalesce(sum(rent_amount), 0),
        'total_repayment',  coalesce(sum(total_repayment), 0),
        'districts_covered', count(DISTINCT district)
      ) FROM prev
    ),
    'by_district', coalesce((
      SELECT jsonb_agg(d ORDER BY (d->>'total_funded')::numeric DESC)
      FROM (
        SELECT jsonb_build_object(
          'district', district,
          'region', min(region),
          'landlords_funded', count(DISTINCT landlord_id),
          'requests_funded', count(*),
          'total_funded', coalesce(sum(rent_amount),0),
          'total_repayment', coalesce(sum(total_repayment),0),
          'avg_per_landlord', CASE WHEN count(DISTINCT landlord_id)=0 THEN 0
            ELSE round(coalesce(sum(rent_amount),0)/count(DISTINCT landlord_id),0) END,
          'previous_landlords_funded', (
            SELECT count(DISTINCT p.landlord_id) FROM prev p WHERE p.district = c.district),
          'previous_total_funded', (
            SELECT coalesce(sum(p.rent_amount),0) FROM prev p WHERE p.district = c.district)
        ) AS d
        FROM cur c GROUP BY district
      ) x
    ), '[]'::jsonb),
    'by_agent', coalesce((
      SELECT jsonb_agg(a ORDER BY (a->>'total_funded')::numeric DESC)
      FROM (
        SELECT jsonb_build_object(
          'agent_name', agent_name,
          'service_centre', min(service_centre),
          'landlords_funded', count(DISTINCT landlord_id),
          'requests_funded', count(*),
          'total_funded', coalesce(sum(rent_amount),0),
          'districts', count(DISTINCT district),
          'previous_landlords_funded', (
            SELECT count(DISTINCT p.landlord_id) FROM prev p WHERE p.agent_name = c.agent_name),
          'previous_total_funded', (
            SELECT coalesce(sum(p.rent_amount),0) FROM prev p WHERE p.agent_name = c.agent_name)
        ) AS a
        FROM cur c GROUP BY agent_name
      ) x
    ), '[]'::jsonb),
    'by_service_centre', coalesce((
      SELECT jsonb_agg(s ORDER BY (s->>'total_funded')::numeric DESC)
      FROM (
        SELECT jsonb_build_object(
          'service_centre', service_centre,
          'agents', count(DISTINCT agent_name),
          'landlords_funded', count(DISTINCT landlord_id),
          'requests_funded', count(*),
          'total_funded', coalesce(sum(rent_amount),0),
          'previous_landlords_funded', (
            SELECT count(DISTINCT p.landlord_id) FROM prev p WHERE p.service_centre = c.service_centre),
          'previous_total_funded', (
            SELECT coalesce(sum(p.rent_amount),0) FROM prev p WHERE p.service_centre = c.service_centre)
        ) AS s
        FROM cur c GROUP BY service_centre
      ) x
    ), '[]'::jsonb),
    'daily', coalesce((
      SELECT jsonb_agg(t ORDER BY t->>'day')
      FROM (
        SELECT jsonb_build_object(
          'day', to_char(date_trunc('day', funded_at), 'YYYY-MM-DD'),
          'landlords_funded', count(DISTINCT landlord_id),
          'requests_funded', count(*),
          'total_funded', coalesce(sum(rent_amount),0)
        ) AS t
        FROM cur GROUP BY date_trunc('day', funded_at)
      ) x
    ), '[]'::jsonb),
    'rows', coalesce((
      SELECT jsonb_agg(r ORDER BY r->>'funded_at' DESC)
      FROM (
        SELECT jsonb_build_object(
          'landlord_id', c.landlord_id,
          'landlord_name', coalesce(c.landlord_name,'—'),
          'landlord_phone', c.landlord_phone,
          'verified', coalesce(c.landlord_verified,false),
          'district', c.district,
          'region', c.region,
          'tenant_name', c.tenant_name,
          'agent_name', c.agent_name,
          'service_centre', c.service_centre,
          'funded_at', c.funded_at,
          'rent_amount', c.rent_amount,
          'total_repayment', c.total_repayment,
          'status', c.status,
          'payout_channel', CASE
            WHEN nullif(btrim(coalesce(c.mobile_money_number,'')),'') IS NOT NULL THEN 'Mobile money'
            WHEN nullif(btrim(coalesce(c.bank_name,'')),'') IS NOT NULL THEN 'Bank'
            ELSE 'Not set' END,
          'first_time', (fe.first_funded_at >= v_from AND fe.first_funded_at < v_to)
        ) AS r
        FROM cur c LEFT JOIN first_ever fe ON fe.landlord_id = c.landlord_id
        LIMIT 5000
      ) x
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.ops_landlord_funded_stats(timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_landlord_funded_stats(timestamptz, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_landlord_funded_stats(timestamptz, timestamptz, text) TO service_role;