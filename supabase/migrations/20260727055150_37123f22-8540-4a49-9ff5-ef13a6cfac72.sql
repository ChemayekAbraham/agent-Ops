CREATE OR REPLACE FUNCTION public.restore_campaign_attribution(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attr public.campaign_attributions;
  v_link public.recruitment_campaign_links;
  v_camp_status public.recruitment_campaign_status;
  v_agent_name text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 8 THEN RETURN jsonb_build_object('status','invalid'); END IF;
  SELECT * INTO v_attr FROM public.campaign_attributions WHERE attribution_token = p_token;
  IF v_attr.id IS NULL THEN RETURN jsonb_build_object('status','invalid'); END IF;
  IF v_attr.status = 'registration_completed' THEN RETURN jsonb_build_object('status','completed'); END IF;
  IF v_attr.status IN ('invalidated','existing_user','duplicate') THEN
    RETURN jsonb_build_object('status', v_attr.status::text);
  END IF;
  IF v_attr.expires_at <= now() THEN
    UPDATE public.campaign_attributions SET status='expired' WHERE id=v_attr.id AND status<>'expired';
    RETURN jsonb_build_object('status','expired');
  END IF;

  SELECT * INTO v_link FROM public.recruitment_campaign_links WHERE id = v_attr.campaign_link_id;
  IF v_link.id IS NULL OR v_link.status <> 'active' THEN
    RETURN jsonb_build_object('status','link_inactive');
  END IF;
  SELECT status INTO v_camp_status FROM public.recruitment_campaigns WHERE id = v_attr.campaign_id;
  IF v_camp_status <> 'active' THEN RETURN jsonb_build_object('status','campaign_inactive'); END IF;

  UPDATE public.campaign_attributions SET last_seen_at = now() WHERE id = v_attr.id;

  SELECT COALESCE(full_name, split_part(email,'@',1))
    INTO v_agent_name
  FROM public.profiles
  WHERE id = v_attr.referring_agent_id;

  RETURN jsonb_build_object(
    'status','ok',
    'attribution_token', v_attr.attribution_token,
    'locked', v_attr.locked_at IS NOT NULL,
    'campaign_link_id', v_attr.campaign_link_id,
    'campaign_id', v_attr.campaign_id,
    'referring_agent_id', v_attr.referring_agent_id,
    'referring_agent_name', v_agent_name,
    'campaign_location_id', v_attr.campaign_location_id,
    'selected_source', v_attr.selected_source,
    'link_type', v_attr.link_type,
    'canonical_slug', v_link.location_slug,
    'short_code', v_link.short_code
  );
END $function$;