-- Install funnel: count iOS installs.
-- iOS has no appinstalled event and no install-prompt outcome, so the funnel showed 0 installs for
-- iOS while the guide was opened 487 times. Installs are now taken from (a) the new first
-- home-screen-launch event (app_installed, metadata.surface = 'ios_standalone_first_launch', with a
-- per-install install_id for signed-out users) and (b) signed-in users whose events were recorded
-- with display_mode = standalone, which recovers installs from before the event existed.
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
           COALESCE(e.user_id::text, NULLIF(e.metadata->>'install_id', ''), 'anon:' || e.id::text) AS ident
    FROM install_attempt_events e
    WHERE e.created_at >= p_start AND e.created_at <= p_end
      AND e.event_type IN ('ios_guide_opened', 'copy_link_clicked', 'copy_link_success', 'app_installed', 'native_prompt_accepted')
      AND (p_platform = 'all'
           OR (p_platform IN ('ios', 'android') AND e.platform = p_platform)
           OR (p_platform = 'other' AND COALESCE(e.platform, '') NOT IN ('ios', 'android')))
  ),
  -- iOS never fires appinstalled. A signed-in user whose events were recorded while the app ran from
  -- the home screen (display_mode = standalone) has installed it, which also covers the days before
  -- the first-launch app_installed event existed. Signed-out users are only counted through that
  -- event (iPhone user agents are too alike to tell devices apart).
  sa AS (
    SELECT DISTINCT 'Safari (iOS)'::text AS browser, e.user_id::text AS ident, 4 AS step
    FROM install_attempt_events e
    WHERE e.created_at >= p_start AND e.created_at <= p_end
      AND e.platform = 'ios' AND e.user_id IS NOT NULL AND e.display_mode = 'standalone'
      AND p_platform IN ('all', 'ios')
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
    UNION ALL
    SELECT browser, ident, step FROM sa
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
