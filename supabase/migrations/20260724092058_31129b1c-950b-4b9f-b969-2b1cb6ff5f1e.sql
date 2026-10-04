CREATE OR REPLACE FUNCTION public.get_admin_campaign_analytics(
  p_campaign_id uuid DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_summary jsonb; v_by_location jsonb; v_by_source jsonb; v_by_agent jsonb; v_funnel jsonb;
BEGIN
  IF NOT (public.has_role(v_uid,'manager') OR public.has_role(v_uid,'cto') OR public.has_role(v_uid,'coo') OR public.has_role(v_uid,'cmo') OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'super_admin')) THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  WITH l AS (
    SELECT * FROM public.recruitment_campaign_links
     WHERE (p_campaign_id IS NULL OR campaign_id = p_campaign_id)
       AND (p_from IS NULL OR created_at >= p_from)
       AND (p_to   IS NULL OR created_at <= p_to)
  )
  SELECT jsonb_build_object(
    'campaigns',        (SELECT COUNT(*) FROM public.recruitment_campaigns),
    'active_campaigns', (SELECT COUNT(*) FROM public.recruitment_campaigns WHERE status='active'),
    'agents',           (SELECT COUNT(DISTINCT agent_id) FROM l),
    'links',            (SELECT COUNT(*) FROM l),
    'clicks',           (SELECT COALESCE(SUM(total_clicks),0) FROM l),
    'unique_clicks',    (SELECT COALESCE(SUM(unique_clicks),0) FROM l),
    'registrations',    (SELECT COALESCE(SUM(total_registrations),0) FROM l),
    'sub_agents',       (SELECT COALESCE(SUM(total_sub_agent_registrations),0) FROM l),
    'qualified',        (SELECT COALESCE(SUM(qualified_sub_agents),0) FROM l),
    'rewards_qualified',(SELECT COUNT(*) FROM public.recruitment_campaign_registrations
                          WHERE reward_qualified_at IS NOT NULL
                            AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id))
  ) INTO v_summary;

  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.clicks DESC NULLS LAST), '[]'::jsonb) INTO v_by_location
  FROM (
    SELECT COALESCE(loc.district, l.district_name, 'Unknown') AS district,
           COUNT(l.*) AS links,
           COALESCE(SUM(l.total_clicks),0) AS clicks,
           COALESCE(SUM(l.unique_clicks),0) AS unique_clicks,
           COALESCE(SUM(l.total_registrations),0) AS registrations,
           COALESCE(SUM(l.total_sub_agent_registrations),0) AS sub_agents,
           COALESCE(SUM(l.qualified_sub_agents),0) AS qualified
      FROM public.recruitment_campaign_links l
      LEFT JOIN public.recruitment_locations loc ON loc.id = l.location_id
     WHERE (p_campaign_id IS NULL OR l.campaign_id = p_campaign_id)
       AND (p_from IS NULL OR l.created_at >= p_from)
       AND (p_to   IS NULL OR l.created_at <= p_to)
     GROUP BY COALESCE(loc.district, l.district_name, 'Unknown')
  ) x;

  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.clicks DESC NULLS LAST), '[]'::jsonb) INTO v_by_source
  FROM (
    SELECT l.selected_source::text AS selected_source,
           COUNT(*) AS links,
           COALESCE(SUM(l.total_clicks),0) AS clicks,
           COALESCE(SUM(l.unique_clicks),0) AS unique_clicks,
           COALESCE(SUM(l.total_registrations),0) AS registrations,
           COALESCE(SUM(l.total_sub_agent_registrations),0) AS sub_agents,
           COALESCE(SUM(l.qualified_sub_agents),0) AS qualified
      FROM public.recruitment_campaign_links l
     WHERE (p_campaign_id IS NULL OR l.campaign_id = p_campaign_id)
       AND (p_from IS NULL OR l.created_at >= p_from)
       AND (p_to   IS NULL OR l.created_at <= p_to)
     GROUP BY l.selected_source
  ) x;

  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.registrations DESC NULLS LAST), '[]'::jsonb) INTO v_by_agent
  FROM (
    SELECT l.agent_id,
           COALESCE(p.full_name, p.email) AS agent_name,
           (
             SELECT string_agg(DISTINCT d, ', ' ORDER BY d)
               FROM (
                 SELECT COALESCE(loc2.district, l2.district_name) AS d
                   FROM public.recruitment_campaign_links l2
                   LEFT JOIN public.recruitment_locations loc2 ON loc2.id = l2.location_id
                  WHERE l2.agent_id = l.agent_id
                    AND (p_campaign_id IS NULL OR l2.campaign_id = p_campaign_id)
                    AND (p_from IS NULL OR l2.created_at >= p_from)
                    AND (p_to   IS NULL OR l2.created_at <= p_to)
               ) s
              WHERE d IS NOT NULL AND d <> ''
           ) AS districts,
           COUNT(*) AS links,
           COALESCE(SUM(l.total_clicks),0) AS clicks,
           COALESCE(SUM(l.total_registrations),0) AS registrations,
           COALESCE(SUM(l.total_sub_agent_registrations),0) AS sub_agents,
           COALESCE(SUM(l.qualified_sub_agents),0) AS qualified
      FROM public.recruitment_campaign_links l
      LEFT JOIN public.profiles p ON p.id = l.agent_id
     WHERE (p_campaign_id IS NULL OR l.campaign_id = p_campaign_id)
       AND (p_from IS NULL OR l.created_at >= p_from)
       AND (p_to   IS NULL OR l.created_at <= p_to)
     GROUP BY l.agent_id, p.full_name, p.email
     LIMIT 200
  ) x;

  SELECT jsonb_build_object(
    'links',           (SELECT COUNT(*) FROM public.recruitment_campaign_links WHERE p_campaign_id IS NULL OR campaign_id = p_campaign_id),
    'clicks',          (SELECT COALESCE(SUM(total_clicks),0) FROM public.recruitment_campaign_links WHERE p_campaign_id IS NULL OR campaign_id = p_campaign_id),
    'registrations',   (SELECT COUNT(*) FROM public.recruitment_campaign_registrations WHERE p_campaign_id IS NULL OR campaign_id = p_campaign_id),
    'sub_agents',      (SELECT COUNT(*) FROM public.recruitment_campaign_registrations WHERE is_sub_agent AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id)),
    'one_house',       (SELECT COUNT(*) FROM public.recruitment_campaign_registrations WHERE verified_houses_count >= 1 AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id)),
    'two_houses',      (SELECT COUNT(*) FROM public.recruitment_campaign_registrations WHERE verified_houses_count >= 2 AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id)),
    'three_houses',    (SELECT COUNT(*) FROM public.recruitment_campaign_registrations WHERE verified_houses_count >= 3 AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id)),
    'reward_qualified',(SELECT COUNT(*) FROM public.recruitment_campaign_registrations WHERE reward_qualified_at IS NOT NULL AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id)),
    'reward_paid',     (SELECT COUNT(*) FROM public.recruitment_campaign_registrations WHERE reward_paid_at IS NOT NULL AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id))
  ) INTO v_funnel;

  RETURN jsonb_build_object(
    'summary', v_summary,
    'by_location', v_by_location,
    'by_source', v_by_source,
    'by_agent', v_by_agent,
    'funnel', v_funnel
  );
END $$;