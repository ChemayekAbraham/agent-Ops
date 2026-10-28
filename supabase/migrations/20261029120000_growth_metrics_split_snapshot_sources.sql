-- CMO "Growth Metrics" speed-up.
--
-- get_growth_metrics_live did all its work (about a second) on EVERY range-button click, although
-- only the signup source mix depends on the range. It is split in two:
--   * get_growth_snapshot_live()            range-independent KPIs + roles; the page caches it, so
--                                           switching ranges no longer recomputes it.
--   * get_growth_sources_live(start, end)   the cheap range-dependent source mix.
-- The snapshot also reads `profiles` once instead of five times, and counts roles with count(*)
-- (user_roles has a unique (user_id, role) index, so it equals count(DISTINCT user_id)).
-- get_growth_metrics_live is left as it is. Same access rule and the same deleted_at IS NULL rule
-- as the rest of the CMO dashboard.
CREATE OR REPLACE FUNCTION public.get_growth_snapshot_live()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_cut timestamptz := now() - interval '30 days';
  v_kla_today timestamptz := date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
  r jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
    has_role(v_uid,'cmo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo') OR has_role(v_uid,'cfo')
    OR has_role(v_uid,'cto') OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
  ) THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;

  SELECT jsonb_build_object(
    'total_users',      p.total,
    'total_users_prev', p.total_prev,
    'new_users_today',  p.new_today,
    'referral_pct',      round(100.0 * p.referred / NULLIF(p.total, 0), 1),
    'referral_pct_prev', round(100.0 * p.referred_prev / NULLIF(p.total_prev, 0), 1),
    'active_users_30d', a.active,
    'retention_pct',    round(100.0 * a.retained / NULLIF(a.old_users, 0), 1),
    'users_by_role', COALESCE((SELECT jsonb_object_agg(role, c) FROM (
        SELECT role::text AS role, count(*) AS c FROM user_roles WHERE enabled IS NOT FALSE GROUP BY 1) y), '{}'::jsonb),
    'computed_at', now()
  ) INTO r
  FROM (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE created_at < v_cut) AS total_prev,
           count(*) FILTER (WHERE created_at >= v_kla_today) AS new_today,
           count(*) FILTER (WHERE referrer_id IS NOT NULL) AS referred,
           count(*) FILTER (WHERE referrer_id IS NOT NULL AND created_at < v_cut) AS referred_prev
    FROM profiles WHERE deleted_at IS NULL
  ) p,
  (
    SELECT count(*) FILTER (WHERE u.last_sign_in_at >= v_cut) AS active,
           count(*) FILTER (WHERE pr.created_at < v_cut) AS old_users,
           count(*) FILTER (WHERE pr.created_at < v_cut AND u.last_sign_in_at >= v_cut) AS retained
    FROM profiles pr JOIN auth.users u ON u.id = pr.id
    WHERE pr.deleted_at IS NULL
  ) a;
  RETURN r;
END $function$;

CREATE OR REPLACE FUNCTION public.get_growth_sources_live(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
    has_role(v_uid,'cmo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo') OR has_role(v_uid,'cfo')
    OR has_role(v_uid,'cto') OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
  ) THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;

  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('name', s, 'value', c) ORDER BY c DESC) FROM (
      SELECT COALESCE(NULLIF(btrim(signup_source), ''), 'organic') AS s, count(*) AS c FROM profiles
      WHERE deleted_at IS NULL AND created_at BETWEEN p_start AND p_end GROUP BY 1) x), '[]'::jsonb);
END $function$;

REVOKE ALL ON FUNCTION public.get_growth_snapshot_live() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_growth_snapshot_live() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_growth_sources_live(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_growth_sources_live(timestamptz, timestamptz) TO authenticated, service_role;
