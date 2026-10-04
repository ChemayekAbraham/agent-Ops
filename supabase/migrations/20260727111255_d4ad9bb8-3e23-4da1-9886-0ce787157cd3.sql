
CREATE OR REPLACE FUNCTION public.get_admin_campaign_analytics(p_campaign_id uuid DEFAULT NULL::uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_summary jsonb; v_by_location jsonb; v_by_source jsonb; v_by_agent jsonb; v_funnel jsonb;
BEGIN
  IF NOT (public.has_role(v_uid,'manager') OR public.has_role(v_uid,'cto') OR public.has_role(v_uid,'coo') OR public.has_role(v_uid,'cmo') OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'super_admin')) THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  SELECT jsonb_build_object(
    'campaigns',        (SELECT COUNT(*) FROM public.recruitment_campaigns),
    'active_campaigns', (SELECT COUNT(*) FROM public.recruitment_campaigns WHERE status='active'),
    'agents',           (SELECT COUNT(DISTINCT agent_id) FROM public.recruitment_campaign_links l
                          WHERE (p_campaign_id IS NULL OR l.campaign_id = p_campaign_id)
                            AND (p_from IS NULL OR l.created_at >= p_from)
                            AND (p_to   IS NULL OR l.created_at <= p_to)),
    'links',            (SELECT COUNT(*) FROM public.recruitment_campaign_links l
                          WHERE (p_campaign_id IS NULL OR l.campaign_id = p_campaign_id)
                            AND (p_from IS NULL OR l.created_at >= p_from)
                            AND (p_to   IS NULL OR l.created_at <= p_to)),
    'clicks',           (SELECT COALESCE(SUM(total_clicks),0) FROM public.recruitment_campaign_links l
                          WHERE (p_campaign_id IS NULL OR l.campaign_id = p_campaign_id)
                            AND (p_from IS NULL OR l.created_at >= p_from)
                            AND (p_to   IS NULL OR l.created_at <= p_to)),
    'unique_clicks',    (SELECT COALESCE(SUM(unique_clicks),0) FROM public.recruitment_campaign_links l
                          WHERE (p_campaign_id IS NULL OR l.campaign_id = p_campaign_id)
                            AND (p_from IS NULL OR l.created_at >= p_from)
                            AND (p_to   IS NULL OR l.created_at <= p_to)),
    'registrations',    (SELECT COUNT(*) FROM public.recruitment_campaign_registrations r
                          WHERE (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
                            AND (p_from IS NULL OR r.registered_at >= p_from)
                            AND (p_to   IS NULL OR r.registered_at <= p_to)),
    'sub_agents',       (SELECT COUNT(*) FROM public.recruitment_campaign_registrations r
                          WHERE (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
                            AND (p_from IS NULL OR r.registered_at >= p_from)
                            AND (p_to   IS NULL OR r.registered_at <= p_to)
                            AND (r.is_sub_agent = true
                                 OR EXISTS (SELECT 1 FROM public.agent_subagents s
                                             WHERE s.sub_agent_id = r.registered_user_id
                                               AND s.parent_agent_id = r.agent_id))),
    'qualified',        (SELECT COUNT(*) FROM public.recruitment_campaign_registrations r
                          WHERE (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
                            AND (p_from IS NULL OR r.registered_at >= p_from)
                            AND (p_to   IS NULL OR r.registered_at <= p_to)
                            AND r.reward_qualified_at IS NOT NULL),
    'rewards_qualified',(SELECT COUNT(*) FROM public.recruitment_campaign_registrations
                          WHERE reward_qualified_at IS NOT NULL
                            AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id))
  ) INTO v_summary;

  -- by_location: sub_agents & registrations & qualified come from registrations table (live)
  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.clicks DESC NULLS LAST), '[]'::jsonb) INTO v_by_location
  FROM (
    WITH links_scope AS (
      SELECT l.*, COALESCE(loc.district, l.district_name, 'Unknown') AS district_key
        FROM public.recruitment_campaign_links l
        LEFT JOIN public.recruitment_locations loc ON loc.id = l.location_id
       WHERE (p_campaign_id IS NULL OR l.campaign_id = p_campaign_id)
         AND (p_from IS NULL OR l.created_at >= p_from)
         AND (p_to   IS NULL OR l.created_at <= p_to)
    ),
    regs_scope AS (
      SELECT r.*, COALESCE(loc.district, l.district_name, 'Unknown') AS district_key,
             (r.is_sub_agent = true
              OR EXISTS (SELECT 1 FROM public.agent_subagents s
                          WHERE s.sub_agent_id = r.registered_user_id
                            AND s.parent_agent_id = r.agent_id)) AS is_sub
        FROM public.recruitment_campaign_registrations r
        LEFT JOIN public.recruitment_campaign_links l ON l.id = r.campaign_link_id
        LEFT JOIN public.recruitment_locations loc ON loc.id = COALESCE(r.location_id, l.location_id)
       WHERE (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
         AND (p_from IS NULL OR r.registered_at >= p_from)
         AND (p_to   IS NULL OR r.registered_at <= p_to)
    )
    SELECT k AS district,
           (SELECT COUNT(*) FROM links_scope WHERE district_key = k) AS links,
           (SELECT COALESCE(SUM(total_clicks),0) FROM links_scope WHERE district_key = k) AS clicks,
           (SELECT COALESCE(SUM(unique_clicks),0) FROM links_scope WHERE district_key = k) AS unique_clicks,
           (SELECT COUNT(*) FROM regs_scope WHERE district_key = k) AS registrations,
           (SELECT COUNT(*) FROM regs_scope WHERE district_key = k AND is_sub) AS sub_agents,
           (SELECT COUNT(*) FROM regs_scope WHERE district_key = k AND reward_qualified_at IS NOT NULL) AS qualified
      FROM (
        SELECT district_key AS k FROM links_scope
        UNION
        SELECT district_key FROM regs_scope
      ) d
  ) x;

  -- by_source
  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.clicks DESC NULLS LAST), '[]'::jsonb) INTO v_by_source
  FROM (
    WITH links_scope AS (
      SELECT l.*
        FROM public.recruitment_campaign_links l
       WHERE (p_campaign_id IS NULL OR l.campaign_id = p_campaign_id)
         AND (p_from IS NULL OR l.created_at >= p_from)
         AND (p_to   IS NULL OR l.created_at <= p_to)
    ),
    regs_scope AS (
      SELECT r.*,
             (r.is_sub_agent = true
              OR EXISTS (SELECT 1 FROM public.agent_subagents s
                          WHERE s.sub_agent_id = r.registered_user_id
                            AND s.parent_agent_id = r.agent_id)) AS is_sub
        FROM public.recruitment_campaign_registrations r
       WHERE (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
         AND (p_from IS NULL OR r.registered_at >= p_from)
         AND (p_to   IS NULL OR r.registered_at <= p_to)
    )
    SELECT s::text AS selected_source,
           (SELECT COUNT(*) FROM links_scope WHERE selected_source::text = s::text) AS links,
           (SELECT COALESCE(SUM(total_clicks),0) FROM links_scope WHERE selected_source::text = s::text) AS clicks,
           (SELECT COALESCE(SUM(unique_clicks),0) FROM links_scope WHERE selected_source::text = s::text) AS unique_clicks,
           (SELECT COUNT(*) FROM regs_scope WHERE selected_source::text = s::text) AS registrations,
           (SELECT COUNT(*) FROM regs_scope WHERE selected_source::text = s::text AND is_sub) AS sub_agents,
           (SELECT COUNT(*) FROM regs_scope WHERE selected_source::text = s::text AND reward_qualified_at IS NOT NULL) AS qualified
      FROM (
        SELECT selected_source::text AS s FROM links_scope
        UNION
        SELECT selected_source::text FROM regs_scope
      ) u
  ) x;

  -- by_agent
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
           (SELECT COUNT(*) FROM public.recruitment_campaign_registrations r
             WHERE r.agent_id = l.agent_id
               AND (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
               AND (p_from IS NULL OR r.registered_at >= p_from)
               AND (p_to   IS NULL OR r.registered_at <= p_to)) AS registrations,
           (SELECT COUNT(*) FROM public.recruitment_campaign_registrations r
             WHERE r.agent_id = l.agent_id
               AND (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
               AND (p_from IS NULL OR r.registered_at >= p_from)
               AND (p_to   IS NULL OR r.registered_at <= p_to)
               AND (r.is_sub_agent = true
                    OR EXISTS (SELECT 1 FROM public.agent_subagents s
                                WHERE s.sub_agent_id = r.registered_user_id
                                  AND s.parent_agent_id = r.agent_id))) AS sub_agents,
           (SELECT COUNT(*) FROM public.recruitment_campaign_registrations r
             WHERE r.agent_id = l.agent_id
               AND (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
               AND (p_from IS NULL OR r.registered_at >= p_from)
               AND (p_to   IS NULL OR r.registered_at <= p_to)
               AND r.reward_qualified_at IS NOT NULL) AS qualified
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
    'sub_agents',      (SELECT COUNT(*) FROM public.recruitment_campaign_registrations r
                         WHERE (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
                           AND (r.is_sub_agent = true
                                OR EXISTS (SELECT 1 FROM public.agent_subagents s
                                            WHERE s.sub_agent_id = r.registered_user_id
                                              AND s.parent_agent_id = r.agent_id))),
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
END $function$;
