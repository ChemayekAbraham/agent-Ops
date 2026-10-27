-- CMO "User Analytics": make the daily series agree with the KPI cards and the selected range.
--
-- get_daily_signups__impl counted soft-deleted (bot/fraud) accounts, so the Daily Signups chart
-- did not add up to the "New Signups" card (which excludes them). Both functions also cut days at
-- UTC midnight while the dashboard builds its ranges from local (Kampala) midnight, so evening
-- activity landed on the wrong day. CREATE OR REPLACE keeps the existing grants.
CREATE OR REPLACE FUNCTION public.get_daily_signups__impl(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(day date, signups bigint, referred bigint, organic bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    (created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
    COUNT(*)::bigint AS signups,
    COUNT(*) FILTER (WHERE referrer_id IS NOT NULL)::bigint AS referred,
    COUNT(*) FILTER (WHERE referrer_id IS NULL)::bigint AS organic
  FROM public.profiles
  WHERE deleted_at IS NULL
    AND created_at >= p_start AND created_at <= p_end
  GROUP BY 1
  ORDER BY 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_daily_active_users__impl(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(day date, active bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    (created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
    COUNT(DISTINCT user_id)::bigint AS active
  FROM public.login_phase_events
  WHERE user_id IS NOT NULL
    AND created_at >= p_start
    AND created_at <= p_end
  GROUP BY 1
  ORDER BY 1;
$function$;
