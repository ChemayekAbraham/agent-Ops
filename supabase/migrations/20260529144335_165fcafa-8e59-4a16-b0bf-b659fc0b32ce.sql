CREATE OR REPLACE FUNCTION public.ops_global_verification_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  WITH ll AS (
    SELECT coalesce(nullif(trim(country), ''), 'Unknown') AS country,
           count(*) FILTER (WHERE verified IS NOT TRUE) AS pending,
           count(*) FILTER (WHERE verified IS NOT TRUE AND created_at >= date_trunc('day', now())) AS pending_today
    FROM landlords
    GROUP BY 1
  ),
  lc AS (
    SELECT coalesce(nullif(trim(country), ''), 'Unknown') AS country,
           count(*) FILTER (WHERE verified IS NOT TRUE) AS pending,
           count(*) FILTER (WHERE verified IS NOT TRUE AND registered_at >= date_trunc('day', now())) AS pending_today
    FROM lc1_chairpersons
    GROUP BY 1
  ),
  rr AS (
    SELECT coalesce(nullif(trim(l.country), ''), 'Unknown') AS country,
           count(*) AS new_requests,
           count(*) FILTER (WHERE r.created_at >= date_trunc('day', now())) AS new_today
    FROM rent_requests r
    LEFT JOIN landlords l ON l.id = r.landlord_id
    WHERE r.status = 'pending'
    GROUP BY 1
  ),
  countries AS (
    SELECT country FROM ll
    UNION SELECT country FROM lc
    UNION SELECT country FROM rr
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'countries', coalesce(jsonb_agg(row ORDER BY (row->>'total')::int DESC), '[]'::jsonb)
  )
  INTO result
  FROM (
    SELECT jsonb_build_object(
      'country', c.country,
      'landlords_pending', coalesce(ll.pending, 0),
      'landlords_pending_today', coalesce(ll.pending_today, 0),
      'lc1_pending', coalesce(lc.pending, 0),
      'lc1_pending_today', coalesce(lc.pending_today, 0),
      'rent_requests_new', coalesce(rr.new_requests, 0),
      'rent_requests_new_today', coalesce(rr.new_today, 0),
      'total', coalesce(ll.pending, 0) + coalesce(lc.pending, 0) + coalesce(rr.new_requests, 0)
    ) AS row
    FROM countries c
    LEFT JOIN ll ON ll.country = c.country
    LEFT JOIN lc ON lc.country = c.country
    LEFT JOIN rr ON rr.country = c.country
  ) rows;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_global_verification_overview() TO authenticated;