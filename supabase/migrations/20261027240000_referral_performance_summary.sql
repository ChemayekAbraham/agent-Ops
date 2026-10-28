-- CMO "Referral Performance": aggregate on the server.
--
-- get_referral_performance_rows returned EVERY referred signup in the range as one JSON array (tens
-- of thousands of rows on the 90/180-day views); the browser then counted, bucketed and ranked them,
-- fetched the top referrers' names in a second request, and the totals also counted soft-deleted
-- accounts. get_referral_performance_summary does all of that in the database and returns only what
-- the page shows: totals, trend buckets (Kampala days/weeks/months), source mix, the top 25
-- referrers with names, and the 100 most recent referred signups. Same access rule and the same
-- "suspected fake" exclusion as before, plus deleted_at IS NULL like the rest of the CMO dashboard.
-- The old function is left in place.
CREATE OR REPLACE FUNCTION public.get_referral_performance_summary(
  p_start timestamptz,
  p_end timestamptz,
  p_granularity text DEFAULT 'day'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_trunc text;
  v_result jsonb;
BEGIN
  IF NOT COALESCE(has_role(v_uid,'super_admin') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo') OR has_role(v_uid,'cfo')
     OR has_role(v_uid,'cto') OR has_role(v_uid,'cmo') OR has_role(v_uid,'manager') OR has_role(v_uid,'hr'), false) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  v_trunc := CASE lower(p_granularity) WHEN 'week' THEN 'week' WHEN 'month' THEN 'month' ELSE 'day' END;

  WITH base AS MATERIALIZED (
    SELECT p.id, p.full_name, p.phone, p.created_at, p.referrer_id, p.signup_source,
           (COALESCE(btrim(p.phone),'') <> '' OR u.last_sign_in_at IS NOT NULL) AS real
    FROM profiles p LEFT JOIN auth.users u ON u.id = p.id
    WHERE p.deleted_at IS NULL AND p.created_at >= p_start AND p.created_at <= p_end
  ),
  refd AS MATERIALIZED (SELECT * FROM base WHERE real AND referrer_id IS NOT NULL),
  trend AS (
    SELECT date_trunc(v_trunc, created_at AT TIME ZONE 'Africa/Kampala')::date AS bucket, count(*)::int AS c
    FROM refd GROUP BY 1
  ),
  src AS (
    SELECT COALESCE(NULLIF(btrim(signup_source), ''), 'unknown') AS source, count(*)::int AS c
    FROM refd GROUP BY 1 ORDER BY c DESC, source LIMIT 12
  ),
  top AS (
    SELECT r.referrer_id, count(*)::int AS total
    FROM refd r GROUP BY 1 ORDER BY total DESC, r.referrer_id LIMIT 25
  ),
  recent AS (
    SELECT id, full_name, phone, created_at, signup_source FROM refd ORDER BY created_at DESC LIMIT 100
  )
  SELECT jsonb_build_object(
    'total_signups',     (SELECT count(*) FROM base WHERE real),
    'excluded_referred', (SELECT count(*) FROM base WHERE NOT real AND referrer_id IS NOT NULL),
    'referred',          (SELECT count(*) FROM refd),
    'active_referrers',  (SELECT count(DISTINCT referrer_id) FROM refd),
    'trend', COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'count', c) ORDER BY bucket) FROM trend), '[]'::jsonb),
    'sources', COALESCE((SELECT jsonb_agg(jsonb_build_object('source', source, 'count', c) ORDER BY c DESC, source) FROM src), '[]'::jsonb),
    'top_referrers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'referrer_id', t.referrer_id, 'total', t.total,
               'full_name', pr.full_name, 'phone', pr.phone) ORDER BY t.total DESC, t.referrer_id)
      FROM top t LEFT JOIN profiles pr ON pr.id = t.referrer_id), '[]'::jsonb),
    'recent', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC) FROM recent r), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.get_referral_performance_summary(timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_referral_performance_summary(timestamptz, timestamptz, text) TO authenticated, service_role;
