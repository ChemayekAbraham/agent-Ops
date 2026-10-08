-- CTO metrics for the 2026-10-07 all-hands action item: successful logins,
-- successful OTPs and a 7-day forecast. Read-only; no ledger or wallet impact.
--
-- Definitions match daily-cto-report (20260918040000) so figures agree with it:
--   login  = login_phase_events phase 'auth.signin.attempt'; success = status 'success'
--   OTP    = otp_login_audit (verify step); success = outcome 'success'
--   OTP sends = sms_delivery_log source 'sms-otp', final attempt only, status sent/accepted/delivered
-- Days are Africa/Kampala calendar days.
--
-- Forecast method: mean and standard deviation of the last p_history_days complete
-- days, projected flat for the next 7 days with a mean +/- 1 sd range (floored at 0).
-- Deliberately simple and labelled as such; it is not a seasonal model.

CREATE OR REPLACE FUNCTION public.get_cto_auth_metrics_forecast(p_history_days int DEFAULT 14)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from date;
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')
    OR auth.role() = 'service_role' OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  p_history_days := LEAST(GREATEST(COALESCE(p_history_days, 14), 7), 60);
  v_from := v_today - p_history_days;

  WITH days AS (
    SELECT d::date AS day FROM generate_series(v_from, v_today - 1, interval '1 day') d
  ),
  logins AS (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           count(*) AS attempts,
           count(*) FILTER (WHERE status = 'success') AS successes
    FROM public.login_phase_events
    WHERE phase = 'auth.signin.attempt'
      AND created_at >= (v_from::text || ' 00:00:00+03')::timestamptz
      AND created_at <  (v_today::text || ' 00:00:00+03')::timestamptz
    GROUP BY 1
  ),
  otp_verify AS (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           count(*) AS verifies,
           count(*) FILTER (WHERE outcome = 'success') AS verified
    FROM public.otp_login_audit
    WHERE created_at >= (v_from::text || ' 00:00:00+03')::timestamptz
      AND created_at <  (v_today::text || ' 00:00:00+03')::timestamptz
    GROUP BY 1
  ),
  otp_send AS (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           count(*) AS sent
    FROM public.sms_delivery_log
    WHERE source = 'sms-otp'
      AND status IN ('sent','accepted','delivered')
      AND NOT (
        provider_response ? 'total_attempts'
        AND (provider_response->>'attempt_sequence')::int < (provider_response->>'total_attempts')::int
      )
      AND created_at >= (v_from::text || ' 00:00:00+03')::timestamptz
      AND created_at <  (v_today::text || ' 00:00:00+03')::timestamptz
    GROUP BY 1
  ),
  series AS (
    SELECT d.day,
           COALESCE(l.attempts, 0)   AS login_attempts,
           COALESCE(l.successes, 0)  AS login_successes,
           COALESCE(s.sent, 0)       AS otp_sent,
           COALESCE(o.verifies, 0)   AS otp_verify_attempts,
           COALESCE(o.verified, 0)   AS otp_verified
    FROM days d
    LEFT JOIN logins l ON l.day = d.day
    LEFT JOIN otp_verify o ON o.day = d.day
    LEFT JOIN otp_send s ON s.day = d.day
  ),
  stats AS (
    SELECT
      avg(login_successes) AS ls_avg, COALESCE(stddev_samp(login_successes), 0) AS ls_sd,
      avg(otp_verified)    AS ov_avg, COALESCE(stddev_samp(otp_verified), 0)    AS ov_sd,
      sum(login_attempts) AS la, sum(login_successes) AS ls,
      sum(otp_sent) AS os, sum(otp_verify_attempts) AS ova, sum(otp_verified) AS ov
    FROM series
  )
  SELECT jsonb_build_object(
    'as_of', v_today,
    'history_days', p_history_days,
    'definitions', jsonb_build_object(
      'login', 'login_phase_events auth.signin.attempt; success = status success (attempts include wrong passwords and unknown numbers)',
      'otp', 'otp_login_audit verify step; success = outcome success',
      'forecast', 'flat projection of the trailing-window daily mean, range = mean +/- 1 sd, floored at 0; not seasonal'
    ),
    'window_totals', jsonb_build_object(
      'login_attempts', st.la, 'login_successes', st.ls,
      'login_success_rate', round(100.0 * st.ls / NULLIF(st.la, 0), 1),
      'otp_sent', st.os, 'otp_verify_attempts', st.ova, 'otp_verified', st.ov,
      'otp_verify_success_rate', round(100.0 * st.ov / NULLIF(st.ova, 0), 1),
      'otp_sent_to_verified_rate', round(100.0 * st.ov / NULLIF(st.os, 0), 1)
    ),
    'daily', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.day) FROM series s),
    'forecast_next_7d', jsonb_build_object(
      'per_day', jsonb_build_object(
        'login_successes', jsonb_build_object('expected', round(st.ls_avg), 'low', GREATEST(round(st.ls_avg - st.ls_sd), 0), 'high', round(st.ls_avg + st.ls_sd)),
        'otp_verified',    jsonb_build_object('expected', round(st.ov_avg), 'low', GREATEST(round(st.ov_avg - st.ov_sd), 0), 'high', round(st.ov_avg + st.ov_sd))
      ),
      'total_7d', jsonb_build_object(
        'login_successes', jsonb_build_object('expected', round(7 * st.ls_avg), 'low', GREATEST(round(7 * (st.ls_avg - st.ls_sd)), 0), 'high', round(7 * (st.ls_avg + st.ls_sd))),
        'otp_verified',    jsonb_build_object('expected', round(7 * st.ov_avg), 'low', GREATEST(round(7 * (st.ov_avg - st.ov_sd)), 0), 'high', round(7 * (st.ov_avg + st.ov_sd)))
      )
    )
  ) INTO v_result
  FROM stats st;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_cto_auth_metrics_forecast(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cto_auth_metrics_forecast(int) TO authenticated, service_role;
