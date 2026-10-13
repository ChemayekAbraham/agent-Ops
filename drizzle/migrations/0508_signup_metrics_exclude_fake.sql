-- Real signup = has a phone number OR has signed in at least once. Sep 10-14 2026 saw ~34.5k bulk accounts
-- with no phone that never signed in (typo email domains); they are excluded from marketing metrics and reported as a count.
CREATE OR REPLACE FUNCTION public.get_signup_totals_range(p_start timestamptz, p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF NOT COALESCE(has_role(v_uid,'super_admin') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo') OR has_role(v_uid,'cfo')
     OR has_role(v_uid,'cto') OR has_role(v_uid,'cmo') OR has_role(v_uid,'manager') OR has_role(v_uid,'hr'), false) THEN
    RAISE EXCEPTION 'not authorized'; END IF;
  RETURN (
    SELECT jsonb_build_object(
      'total', count(*) FILTER (WHERE r)::int,
      'referred', count(*) FILTER (WHERE r AND referrer_id IS NOT NULL)::int,
      'excluded', count(*) FILTER (WHERE NOT r)::int)
    FROM (SELECT p.referrer_id,
                 (COALESCE(btrim(p.phone),'') <> '' OR u.last_sign_in_at IS NOT NULL) AS r
          FROM profiles p LEFT JOIN auth.users u ON u.id = p.id
          WHERE p.created_at >= p_start AND p.created_at <= p_end) s
  );
END; $function$;

CREATE OR REPLACE FUNCTION public.get_signup_trends(p_start timestamptz, p_end timestamptz, p_granularity text DEFAULT 'day')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE v_uid uuid := auth.uid(); v_trunc text; v_result jsonb;
BEGIN
  IF NOT COALESCE(has_role(v_uid,'super_admin') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo') OR has_role(v_uid,'cfo')
     OR has_role(v_uid,'cto') OR has_role(v_uid,'cmo') OR has_role(v_uid,'manager') OR has_role(v_uid,'hr'), false) THEN
    RAISE EXCEPTION 'not authorized'; END IF;
  v_trunc := CASE lower(p_granularity) WHEN 'week' THEN 'week' WHEN 'month' THEN 'month' ELSE 'day' END;

  WITH base AS (
    SELECT p.id, p.full_name, p.phone, p.created_at, p.referrer_id, p.signup_source,
           (p.created_at AT TIME ZONE 'Africa/Kampala') AS kla,
           (COALESCE(btrim(p.phone),'') <> '' OR u.last_sign_in_at IS NOT NULL) AS real
    FROM profiles p LEFT JOIN auth.users u ON u.id = p.id
    WHERE p.created_at >= p_start AND p.created_at <= p_end
  ),
  scoped AS (SELECT * FROM base WHERE real),
  buckets AS (
    SELECT (date_trunc(v_trunc, kla) AT TIME ZONE 'Africa/Kampala') AS bucket, count(*)::int AS total,
           count(*) FILTER (WHERE referrer_id IS NOT NULL)::int AS referred,
           count(*) FILTER (WHERE referrer_id IS NULL)::int AS organic
    FROM scoped GROUP BY 1 ORDER BY 1),
  dow AS (SELECT EXTRACT(DOW FROM kla)::int AS d, count(*)::int AS c FROM scoped GROUP BY 1),
  src AS (
    SELECT lower(coalesce(nullif(signup_source,''), CASE WHEN referrer_id IS NOT NULL THEN 'referral' ELSE 'direct' END)) AS name,
           count(*)::int AS value FROM scoped GROUP BY 1 ORDER BY value DESC LIMIT 6),
  top_days AS (SELECT kla::date AS day, count(*)::int AS c FROM scoped GROUP BY 1 ORDER BY c DESC LIMIT 10),
  recent AS (SELECT id, full_name, phone, created_at, referrer_id, signup_source FROM scoped ORDER BY created_at DESC LIMIT 25),
  totals AS (SELECT count(*) FILTER (WHERE real)::int AS total,
                    count(*) FILTER (WHERE real AND referrer_id IS NOT NULL)::int AS referred,
                    count(*) FILTER (WHERE NOT real)::int AS excluded FROM base)
  SELECT jsonb_build_object(
    'totals', (SELECT to_jsonb(t) FROM totals t),
    'buckets', COALESCE((SELECT jsonb_agg(to_jsonb(b)) FROM buckets b), '[]'::jsonb),
    'dow', COALESCE((SELECT jsonb_agg(jsonb_build_object('d',d,'c',c) ORDER BY d) FROM dow), '[]'::jsonb),
    'source_mix', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM src s), '[]'::jsonb),
    'top_days', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM top_days t), '[]'::jsonb),
    'recent', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM recent r), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END; $function$;