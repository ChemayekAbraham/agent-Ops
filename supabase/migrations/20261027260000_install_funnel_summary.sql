-- CMO "Install funnel": aggregate on the server and stop double-counting installs.
--
-- The page downloaded every tracked event for the range and counted them in the browser:
--   * Supabase returns at most 1,000 rows per request, and the last 30 days already holds ~920
--     tracked events, so longer ranges were silently cut short (oldest rows only, newest dropped).
--   * Every Android install writes TWO events (app_installed and native_prompt_accepted, ~1 s
--     apart). Anonymous ones were keyed by their timestamp, so each install counted twice:
--     "Installed" read 549 when about 330 installs happened.
-- get_install_funnel_summary returns per-browser unique counts for the four steps. Signed-in users
-- count once per step; anonymous events (no session id exists) count individually. A
-- native_prompt_accepted that has an app_installed twin (same user, same device user agent, within
-- 60 s) is the same install and is not counted again.
CREATE OR REPLACE FUNCTION public.get_install_funnel_summary(
  p_start timestamptz,
  p_end timestamptz,
  p_platform text DEFAULT 'all'
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
  IF p_platform NOT IN ('all', 'ios', 'android', 'other') THEN
    RAISE EXCEPTION 'invalid platform %', p_platform USING ERRCODE = '22023';
  END IF;

  WITH ev AS MATERIALIZED (
    SELECT e.id, e.event_type, e.user_id, e.created_at, e.user_agent,
           CASE
             WHEN NULLIF(btrim(e.in_app_browser_name), '') IS NOT NULL THEN btrim(e.in_app_browser_name)
             WHEN e.in_app_browser IS TRUE THEN 'In-app browser (unknown)'
             WHEN e.platform = 'ios' THEN 'Safari (iOS)'
             WHEN e.platform = 'android' THEN 'Chrome (Android)'
             WHEN NULLIF(e.platform, '') IS NOT NULL THEN e.platform
             ELSE 'Unknown'
           END AS browser,
           COALESCE(e.user_id::text, 'anon:' || e.id::text) AS ident
    FROM install_attempt_events e
    WHERE e.created_at >= p_start AND e.created_at <= p_end
      AND e.event_type IN ('ios_guide_opened', 'copy_link_clicked', 'copy_link_success', 'app_installed', 'native_prompt_accepted')
      AND (p_platform = 'all'
           OR (p_platform IN ('ios', 'android') AND e.platform = p_platform)
           OR (p_platform = 'other' AND COALESCE(e.platform, '') NOT IN ('ios', 'android')))
  ),
  steps AS (
    SELECT e.browser, e.ident,
           CASE e.event_type
             WHEN 'ios_guide_opened' THEN 1
             WHEN 'copy_link_clicked' THEN 2
             WHEN 'copy_link_success' THEN 3
             ELSE 4
           END AS step
    FROM ev e
    WHERE NOT (
      e.event_type = 'native_prompt_accepted'
      AND EXISTS (
        SELECT 1 FROM ev a
        WHERE a.event_type = 'app_installed'
          AND a.user_id IS NOT DISTINCT FROM e.user_id
          AND a.user_agent IS NOT DISTINCT FROM e.user_agent
          AND abs(extract(epoch FROM a.created_at - e.created_at)) < 60
      )
    )
  ),
  per_browser AS (
    SELECT browser,
           count(DISTINCT ident) FILTER (WHERE step = 1)::int AS s1,
           count(DISTINCT ident) FILTER (WHERE step = 2)::int AS s2,
           count(DISTINCT ident) FILTER (WHERE step = 3)::int AS s3,
           count(DISTINCT ident) FILTER (WHERE step = 4)::int AS s4
    FROM steps GROUP BY browser
  )
  SELECT jsonb_build_object(
    'totals', (SELECT jsonb_build_array(
                 count(DISTINCT ident) FILTER (WHERE step = 1),
                 count(DISTINCT ident) FILTER (WHERE step = 2),
                 count(DISTINCT ident) FILTER (WHERE step = 3),
                 count(DISTINCT ident) FILTER (WHERE step = 4)) FROM steps),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('browser', browser, 'counts', jsonb_build_array(s1, s2, s3, s4))
                                       ORDER BY s1 DESC, s4 DESC, browser) FROM per_browser), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.get_install_funnel_summary(timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_install_funnel_summary(timestamptz, timestamptz, text) TO authenticated, service_role;
