CREATE OR REPLACE FUNCTION public.get_growth_metrics_live(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cut timestamptz := now() - interval '30 days';
  v_kla_today timestamptz := date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
  r jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
    has_role(v_uid,'cmo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo') OR has_role(v_uid,'cfo')
    OR has_role(v_uid,'cto') OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  SELECT jsonb_build_object(
    'total_users', (SELECT count(*) FROM profiles),
    'total_users_prev', (SELECT count(*) FROM profiles WHERE created_at < v_cut),
    'active_users_30d', (SELECT count(*) FROM auth.users WHERE last_sign_in_at >= v_cut),
    'new_users_today', (SELECT count(*) FROM profiles WHERE created_at >= v_kla_today),
    'retention_pct', (SELECT round(100.0 * count(*) FILTER (WHERE u.last_sign_in_at >= v_cut) / NULLIF(count(*),0), 1)
                      FROM profiles p JOIN auth.users u ON u.id = p.id WHERE p.created_at < v_cut),
    'referral_pct', (SELECT round(100.0 * count(*) FILTER (WHERE referrer_id IS NOT NULL) / NULLIF(count(*),0), 1) FROM profiles),
    'referral_pct_prev', (SELECT round(100.0 * count(*) FILTER (WHERE referrer_id IS NOT NULL) / NULLIF(count(*),0), 1) FROM profiles WHERE created_at < v_cut),
    'sources', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', s, 'value', c) ORDER BY c DESC) FROM (
        SELECT COALESCE(NULLIF(btrim(signup_source),''),'organic') s, count(*) c FROM profiles
        WHERE created_at BETWEEN p_start AND p_end GROUP BY 1) x), '[]'::jsonb),
    'users_by_role', COALESCE((SELECT jsonb_object_agg(role, c) FROM (
        SELECT role::text role, count(DISTINCT user_id) c FROM user_roles WHERE enabled IS NOT FALSE GROUP BY 1) y), '{}'::jsonb),
    'computed_at', now()
  ) INTO r;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.get_growth_metrics_live(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_growth_metrics_live(timestamptz, timestamptz) TO authenticated;