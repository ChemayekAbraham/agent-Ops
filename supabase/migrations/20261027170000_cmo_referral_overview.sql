-- CMO dashboard: platform-wide referral figures.
--
-- The dashboard read the `referrals` table directly, but row-level security only lets the
-- `manager` role (and each referrer, for their own rows) see it. A CMO therefore saw only
-- their OWN referrals: 41 total / 20 completed this year, against 53,393 / 43,302 in the
-- database. These two SECURITY DEFINER functions return the real figures to the roles that
-- already see the other CMO tabs (get_referral_performance_rows, signup_source_funnel).
--
-- A referral counts only while the referred account is not deleted (deleted_at IS NULL), so
-- soft-deleted bot accounts never count as growth. Boundaries are passed in by the caller so
-- months line up with the dashboard's own (browser-local) month edges.

CREATE OR REPLACE FUNCTION public.cmo_referral_access_ok(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    has_role(_uid, 'cmo') OR has_role(_uid, 'ceo') OR has_role(_uid, 'coo') OR has_role(_uid, 'cfo')
    OR has_role(_uid, 'cto') OR has_role(_uid, 'manager') OR has_role(_uid, 'super_admin'),
    false);
$function$;

REVOKE ALL ON FUNCTION public.cmo_referral_access_ok(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cmo_referral_access_ok(uuid) TO service_role;


-- Totals for the range, and per-month counts for the charts. Independent of the status filter.
-- p_months: [{"label":"May 2026","s":"<timestamptz>","e":"<timestamptz>"}, ...]
CREATE OR REPLACE FUNCTION public.get_cmo_referral_totals(
  p_start timestamptz,
  p_end timestamptz,
  p_months jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT public.cmo_referral_access_ok(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  WITH active AS MATERIALIZED (
    SELECT rf.created_at, COALESCE(rf.credited, false) AS credited
    FROM public.referrals rf
    JOIN public.profiles pr ON pr.id = rf.referred_id AND pr.deleted_at IS NULL
  ),
  months AS (
    SELECT m.label, m.s, m.e
    FROM jsonb_to_recordset(COALESCE(p_months, '[]'::jsonb)) AS m(label text, s timestamptz, e timestamptz)
  )
  SELECT jsonb_build_object(
    'total',     (SELECT count(*) FROM active WHERE created_at >= p_start AND created_at <= p_end),
    'pending',   (SELECT count(*) FROM active WHERE created_at >= p_start AND created_at <= p_end AND NOT credited),
    'completed', (SELECT count(*) FROM active WHERE created_at >= p_start AND created_at <= p_end AND credited),
    'by_month', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'label', mo.label,
               'total', c.total, 'pending', c.pending, 'completed', c.completed) ORDER BY mo.s)
      FROM months mo
      CROSS JOIN LATERAL (
        SELECT count(*) AS total,
               count(*) FILTER (WHERE NOT a.credited) AS pending,
               count(*) FILTER (WHERE a.credited) AS completed
        FROM active a WHERE a.created_at >= mo.s AND a.created_at <= mo.e
      ) c), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.get_cmo_referral_totals(timestamptz, timestamptz, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cmo_referral_totals(timestamptz, timestamptz, jsonb) TO authenticated, service_role;


-- Top referrers (20) and the 200 most recent referrals for the range, narrowed by status.
-- p_status: 'all' | 'pending' | 'completed'.
CREATE OR REPLACE FUNCTION public.get_cmo_referral_lists(
  p_start timestamptz,
  p_end timestamptz,
  p_status text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text := lower(COALESCE(p_status, 'all'));
  v_result jsonb;
BEGIN
  IF NOT public.cmo_referral_access_ok(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_status NOT IN ('all', 'pending', 'completed') THEN
    RAISE EXCEPTION 'invalid status %', p_status USING ERRCODE = '22023';
  END IF;

  WITH r AS MATERIALIZED (
    SELECT rf.id, rf.referrer_id, rf.referred_id, rf.created_at, COALESCE(rf.credited, false) AS credited
    FROM public.referrals rf
    JOIN public.profiles pr ON pr.id = rf.referred_id AND pr.deleted_at IS NULL
    WHERE rf.created_at >= p_start AND rf.created_at <= p_end
  ),
  top AS (
    SELECT t.referrer_id,
           count(*) AS total,
           count(*) FILTER (WHERE NOT t.credited) AS pending,
           count(*) FILTER (WHERE t.credited) AS completed
    FROM r t
    WHERE v_status = 'all' OR (v_status = 'pending' AND NOT t.credited) OR (v_status = 'completed' AND t.credited)
    GROUP BY t.referrer_id
  ),
  top20 AS (
    SELECT *, row_number() OVER (
             ORDER BY CASE v_status WHEN 'pending' THEN pending WHEN 'completed' THEN completed ELSE total END DESC,
                      total DESC, referrer_id) AS rank
    FROM top
    ORDER BY rank
    LIMIT 20
  ),
  recent AS (
    SELECT x.id, x.created_at, x.credited, x.referred_id, x.referrer_id
    FROM r x
    WHERE v_status = 'all' OR (v_status = 'pending' AND NOT x.credited) OR (v_status = 'completed' AND x.credited)
    ORDER BY x.created_at DESC
    LIMIT 200
  )
  SELECT jsonb_build_object(
    'top_referrers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'rank', t.rank,
               'referrer_id', t.referrer_id,
               'name', COALESCE(NULLIF(btrim(p.full_name), ''), p.phone, 'Unknown'),
               'referrals', t.total, 'pending', t.pending, 'completed', t.completed) ORDER BY t.rank)
      FROM top20 t LEFT JOIN public.profiles p ON p.id = t.referrer_id), '[]'::jsonb),
    'recent', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', x.id, 'created_at', x.created_at, 'credited', x.credited,
               'referred_name', COALESCE(NULLIF(btrim(pd.full_name), ''), pd.phone, 'Unknown'),
               'referrer_name', COALESCE(NULLIF(btrim(pr.full_name), ''), pr.phone, 'Unknown')) ORDER BY x.created_at DESC)
      FROM recent x
      LEFT JOIN public.profiles pd ON pd.id = x.referred_id
      LEFT JOIN public.profiles pr ON pr.id = x.referrer_id), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.get_cmo_referral_lists(timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cmo_referral_lists(timestamptz, timestamptz, text) TO authenticated, service_role;
