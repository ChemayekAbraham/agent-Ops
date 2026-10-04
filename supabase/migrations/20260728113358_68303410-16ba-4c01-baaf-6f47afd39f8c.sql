
CREATE OR REPLACE FUNCTION public.get_signup_trends(
  p_start timestamptz,
  p_end   timestamptz,
  p_granularity text DEFAULT 'day'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_allowed boolean;
  v_trunc text;
  v_result jsonb;
BEGIN
  v_allowed := public.has_role(v_uid,'super_admin')
            OR public.has_role(v_uid,'ceo')
            OR public.has_role(v_uid,'coo')
            OR public.has_role(v_uid,'cfo')
            OR public.has_role(v_uid,'cto')
            OR public.has_role(v_uid,'cmo')
            OR public.has_role(v_uid,'manager')
            OR public.has_role(v_uid,'hr');
  IF NOT COALESCE(v_allowed,false) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_trunc := CASE lower(p_granularity)
    WHEN 'week' THEN 'week'
    WHEN 'month' THEN 'month'
    ELSE 'day'
  END;

  WITH scoped AS (
    SELECT id, full_name, phone, created_at, referrer_id, signup_source
    FROM public.profiles
    WHERE created_at >= p_start AND created_at <= p_end
  ),
  buckets AS (
    SELECT date_trunc(v_trunc, created_at) AS bucket,
           count(*)::int AS total,
           count(*) FILTER (WHERE referrer_id IS NOT NULL)::int AS referred,
           count(*) FILTER (WHERE referrer_id IS NULL)::int AS organic
    FROM scoped GROUP BY 1 ORDER BY 1
  ),
  dow AS (
    SELECT EXTRACT(DOW FROM created_at)::int AS d, count(*)::int AS c
    FROM scoped GROUP BY 1
  ),
  src AS (
    SELECT lower(coalesce(nullif(signup_source,''),
                          CASE WHEN referrer_id IS NOT NULL THEN 'referral' ELSE 'direct' END)) AS name,
           count(*)::int AS value
    FROM scoped GROUP BY 1 ORDER BY value DESC LIMIT 6
  ),
  top_days AS (
    SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS c
    FROM scoped GROUP BY 1 ORDER BY c DESC LIMIT 10
  ),
  recent AS (
    SELECT id, full_name, phone, created_at, referrer_id, signup_source
    FROM scoped ORDER BY created_at DESC LIMIT 25
  ),
  totals AS (
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE referrer_id IS NOT NULL)::int AS referred
    FROM scoped
  )
  SELECT jsonb_build_object(
    'totals', (SELECT to_jsonb(t) FROM totals t),
    'buckets', COALESCE((SELECT jsonb_agg(to_jsonb(b)) FROM buckets b), '[]'::jsonb),
    'dow', COALESCE((SELECT jsonb_agg(jsonb_build_object('d',d,'c',c) ORDER BY d) FROM dow), '[]'::jsonb),
    'source_mix', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM src s), '[]'::jsonb),
    'top_days', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM top_days t), '[]'::jsonb),
    'recent', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM recent r), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_signup_trends(timestamptz, timestamptz, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_signup_totals_range(
  p_start timestamptz,
  p_end   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_allowed boolean;
BEGIN
  v_allowed := public.has_role(v_uid,'super_admin')
            OR public.has_role(v_uid,'ceo')
            OR public.has_role(v_uid,'coo')
            OR public.has_role(v_uid,'cfo')
            OR public.has_role(v_uid,'cto')
            OR public.has_role(v_uid,'cmo')
            OR public.has_role(v_uid,'manager')
            OR public.has_role(v_uid,'hr');
  IF NOT COALESCE(v_allowed,false) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'total', count(*)::int,
      'referred', count(*) FILTER (WHERE referrer_id IS NOT NULL)::int
    )
    FROM public.profiles
    WHERE created_at >= p_start AND created_at <= p_end
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_signup_totals_range(timestamptz, timestamptz) TO authenticated;
