CREATE OR REPLACE FUNCTION public.resolve_campaign_short_code(p_short_code text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'link_id', l.id,
    'campaign_id', l.campaign_id,
    'campaign_name', c.name,
    'agent_id', l.agent_id,
    'location_id', l.location_id,
    'location_slug', COALESCE(l.location_slug, lower(regexp_replace(COALESCE(loc.district, l.district_name, ''), '[^a-zA-Z0-9]+', '-', 'g'))),
    'location_display', COALESCE(loc.display_name, l.district_name),
    'district', COALESCE(loc.district, l.district_name),
    'selected_source', l.selected_source::text,
    'link_type', l.link_type::text,
    'status', l.status::text,
    'campaign_status', c.status::text
  )
  FROM public.recruitment_campaign_links l
  JOIN public.recruitment_campaigns c ON c.id = l.campaign_id
  LEFT JOIN public.recruitment_locations loc ON loc.id = l.location_id
  WHERE l.short_code = p_short_code;
$function$;