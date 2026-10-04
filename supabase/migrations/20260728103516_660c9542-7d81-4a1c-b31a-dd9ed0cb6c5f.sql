
CREATE OR REPLACE FUNCTION public.get_user_role_distribution()
RETURNS TABLE(role text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role::text, COUNT(*)::bigint
  FROM public.user_roles
  GROUP BY role
  ORDER BY COUNT(*) DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_role_distribution() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_daily_signups(p_start timestamptz, p_end timestamptz)
RETURNS TABLE(day date, signups bigint, referred bigint, organic bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (created_at AT TIME ZONE 'UTC')::date AS day,
    COUNT(*)::bigint AS signups,
    COUNT(*) FILTER (WHERE referrer_id IS NOT NULL)::bigint AS referred,
    COUNT(*) FILTER (WHERE referrer_id IS NULL)::bigint AS organic
  FROM public.profiles
  WHERE created_at >= p_start AND created_at <= p_end
  GROUP BY 1
  ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_daily_signups(timestamptz, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_daily_active_users(p_start timestamptz, p_end timestamptz)
RETURNS TABLE(day date, active bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (created_at AT TIME ZONE 'UTC')::date AS day,
    COUNT(DISTINCT user_id)::bigint AS active
  FROM public.login_phase_events
  WHERE user_id IS NOT NULL
    AND created_at >= p_start
    AND created_at <= p_end
  GROUP BY 1
  ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_daily_active_users(timestamptz, timestamptz) TO authenticated, service_role;
