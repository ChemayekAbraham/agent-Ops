-- 1. Backfill link counters from actual registrations (source of truth)
UPDATE public.recruitment_campaign_links l
   SET total_registrations = COALESCE(r.total_regs, 0),
       total_sub_agent_registrations = COALESCE(r.sub_agents, 0),
       qualified_sub_agents = COALESCE(r.qualified, 0)
  FROM (
    SELECT campaign_link_id,
           COUNT(*)::int AS total_regs,
           COUNT(*) FILTER (WHERE is_sub_agent)::int AS sub_agents,
           COUNT(*) FILTER (WHERE qualification_status IN ('reward_qualified','reward_paid'))::int AS qualified
      FROM public.recruitment_campaign_registrations
     GROUP BY campaign_link_id
  ) r
 WHERE r.campaign_link_id = l.id
   AND (
     l.total_registrations IS DISTINCT FROM r.total_regs
     OR l.total_sub_agent_registrations IS DISTINCT FROM r.sub_agents
     OR l.qualified_sub_agents IS DISTINCT FROM r.qualified
   );

-- 2. Self-healing dashboard RPC: read live counts from registrations, not cached counter
CREATE OR REPLACE FUNCTION public.get_agent_campaign_dashboard()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := auth.uid();
  v_campaigns jsonb;
  v_links jsonb;
  v_totals jsonb;
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(c) ORDER BY c.created_at DESC), '[]'::jsonb)
    INTO v_campaigns
    FROM public.recruitment_campaigns c
   WHERE c.status = 'active';

  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.created_at DESC), '[]'::jsonb)
    INTO v_links
    FROM (
      SELECT l.id, l.short_code, l.campaign_id, l.location_id, l.district_name,
             l.location_slug, l.selected_source, l.link_type, l.placement_name,
             l.status, l.total_clicks, l.unique_clicks, l.created_at,
             COALESCE(rc.total_regs, 0) AS total_registrations,
             COALESCE(rc.sub_agents, 0) AS total_sub_agent_registrations,
             COALESCE(rc.qualified, 0) AS qualified_sub_agents,
             c.name AS campaign_name,
             COALESCE(loc.display_name, l.district_name, '') AS location_display
      FROM public.recruitment_campaign_links l
      JOIN public.recruitment_campaigns c ON c.id = l.campaign_id
      LEFT JOIN public.recruitment_locations loc ON loc.id = l.location_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total_regs,
               COUNT(*) FILTER (WHERE is_sub_agent)::int AS sub_agents,
               COUNT(*) FILTER (WHERE qualification_status IN ('reward_qualified','reward_paid'))::int AS qualified
          FROM public.recruitment_campaign_registrations
         WHERE campaign_link_id = l.id
      ) rc ON true
      WHERE l.agent_id = v_agent
      ORDER BY l.created_at DESC
      LIMIT 500
    ) x;

  SELECT jsonb_build_object(
    'links', COUNT(*),
    'clicks', COALESCE(SUM(total_clicks),0),
    'unique_clicks', COALESCE(SUM(unique_clicks),0),
    'registrations', COALESCE(SUM(total_registrations),0),
    'sub_agents', COALESCE(SUM(total_sub_agent_registrations),0),
    'qualified', COALESCE(SUM(qualified_sub_agents),0)
  ) INTO v_totals FROM (
    SELECT l.total_clicks, l.unique_clicks,
           COALESCE(rc.total_regs, 0) AS total_registrations,
           COALESCE(rc.sub_agents, 0) AS total_sub_agent_registrations,
           COALESCE(rc.qualified, 0) AS qualified_sub_agents
      FROM public.recruitment_campaign_links l
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total_regs,
               COUNT(*) FILTER (WHERE is_sub_agent)::int AS sub_agents,
               COUNT(*) FILTER (WHERE qualification_status IN ('reward_qualified','reward_paid'))::int AS qualified
          FROM public.recruitment_campaign_registrations
         WHERE campaign_link_id = l.id
      ) rc ON true
     WHERE l.agent_id = v_agent
  ) t;

  RETURN jsonb_build_object('campaigns', v_campaigns, 'links', v_links, 'totals', v_totals);
END $function$;