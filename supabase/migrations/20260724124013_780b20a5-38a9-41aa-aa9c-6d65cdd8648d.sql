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
      SELECT l.*, c.name AS campaign_name,
             COALESCE(loc.display_name, l.district_name, '') AS location_display
      FROM public.recruitment_campaign_links l
      JOIN public.recruitment_campaigns c ON c.id = l.campaign_id
      LEFT JOIN public.recruitment_locations loc ON loc.id = l.location_id
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
  ) INTO v_totals
    FROM public.recruitment_campaign_links WHERE agent_id = v_agent;

  RETURN jsonb_build_object('campaigns', v_campaigns, 'links', v_links, 'totals', v_totals);
END $function$;