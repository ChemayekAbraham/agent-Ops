-- Referral Performance reads only real signups (phone number present OR signed in at least once), matching Signup Trends.
CREATE OR REPLACE FUNCTION public.get_referral_performance_rows(p_start timestamptz, p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF NOT COALESCE(has_role(v_uid,'super_admin') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo') OR has_role(v_uid,'cfo')
     OR has_role(v_uid,'cto') OR has_role(v_uid,'cmo') OR has_role(v_uid,'manager') OR has_role(v_uid,'hr'), false) THEN
    RAISE EXCEPTION 'not authorized'; END IF;
  RETURN (
    WITH base AS (
      SELECT p.id, p.full_name, p.phone, p.created_at, p.referrer_id, p.signup_source,
             (COALESCE(btrim(p.phone),'') <> '' OR u.last_sign_in_at IS NOT NULL) AS real
      FROM profiles p LEFT JOIN auth.users u ON u.id = p.id
      WHERE p.created_at >= p_start AND p.created_at <= p_end)
    SELECT jsonb_build_object(
      'total_signups', count(*) FILTER (WHERE real),
      'excluded_referred', count(*) FILTER (WHERE NOT real AND referrer_id IS NOT NULL),
      'rows', COALESCE(jsonb_agg(jsonb_build_object('id',id,'full_name',full_name,'phone',phone,'created_at',created_at,
                 'referrer_id',referrer_id,'signup_source',signup_source) ORDER BY created_at DESC)
                 FILTER (WHERE real AND referrer_id IS NOT NULL), '[]'::jsonb))
    FROM base);
END; $function$;
REVOKE ALL ON FUNCTION public.get_referral_performance_rows(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_referral_performance_rows(timestamptz, timestamptz) TO authenticated;