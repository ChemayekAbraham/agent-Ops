
CREATE OR REPLACE FUNCTION public.link_campaign_sub_agent(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reg   public.recruitment_campaign_registrations;
  v_link  public.recruitment_campaign_links;
  v_camp_status public.recruitment_campaign_status;
  v_existing_parent uuid;
  v_result text;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('status','no_user'); END IF;
  IF NOT public.has_role(p_user_id, 'agent') THEN RETURN jsonb_build_object('status','user_not_agent'); END IF;

  SELECT * INTO v_reg FROM public.recruitment_campaign_registrations
   WHERE registered_user_id = p_user_id ORDER BY registered_at DESC LIMIT 1;
  IF v_reg.id IS NULL THEN RETURN jsonb_build_object('status','no_registration'); END IF;

  SELECT * INTO v_link FROM public.recruitment_campaign_links WHERE id = v_reg.campaign_link_id;
  IF v_link.id IS NULL THEN RETURN jsonb_build_object('status','link_missing'); END IF;
  IF v_link.agent_id IS NULL OR v_link.agent_id = p_user_id THEN
    RETURN jsonb_build_object('status','self_referral_blocked');
  END IF;
  SELECT status INTO v_camp_status FROM public.recruitment_campaigns WHERE id = v_reg.campaign_id;
  IF v_link.status = 'disabled' THEN RETURN jsonb_build_object('status','link_disabled'); END IF;

  SELECT parent_agent_id INTO v_existing_parent
    FROM public.agent_subagents WHERE sub_agent_id = p_user_id;

  IF v_existing_parent IS NOT NULL THEN
    IF v_existing_parent = v_link.agent_id THEN
      v_result := 'reused';
    ELSE
      INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
      VALUES (
        p_user_id, 'campaign_sub_agent_link_conflict', 'agent_subagents', v_existing_parent,
        jsonb_build_object(
          'reason','Sub-agent already owned by a different parent; campaign attribution kept but no ownership transfer.',
          'registration_id', v_reg.id,'campaign_link_id', v_link.id,
          'campaign_agent_id', v_link.agent_id,'existing_parent_agent_id', v_existing_parent
        )
      );
      RETURN jsonb_build_object('status','other_parent_conflict',
        'existing_parent_agent_id', v_existing_parent,'campaign_agent_id', v_link.agent_id);
    END IF;
  ELSE
    INSERT INTO public.agent_subagents(parent_agent_id, sub_agent_id, source, status, verified_at)
    VALUES (v_link.agent_id, p_user_id, 'campaign_link', 'verified', now())
    ON CONFLICT (sub_agent_id) DO NOTHING;

    IF NOT FOUND THEN
      SELECT parent_agent_id INTO v_existing_parent FROM public.agent_subagents WHERE sub_agent_id = p_user_id;
      v_result := CASE WHEN v_existing_parent = v_link.agent_id THEN 'reused' ELSE 'race_conflict' END;
    ELSE
      v_result := 'created';
    END IF;
  END IF;

  UPDATE public.recruitment_campaign_registrations
     SET is_sub_agent = true,
         qualification_status = CASE
           WHEN qualification_status IN ('reward_qualified','reward_paid') THEN qualification_status
           ELSE 'active'::recruitment_registration_status
         END
   WHERE id = v_reg.id
     AND (is_sub_agent IS DISTINCT FROM true OR qualification_status = 'registered');

  IF v_result = 'created' THEN
    UPDATE public.recruitment_campaign_links
       SET total_sub_agent_registrations = total_sub_agent_registrations + 1
     WHERE id = v_link.id
       AND NOT EXISTS (
         SELECT 1 FROM public.audit_logs
          WHERE action_type='campaign_sub_agent_linked'
            AND user_id = p_user_id
            AND (metadata->>'campaign_link_id')::uuid = v_link.id
       );
  END IF;

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (
    p_user_id,
    CASE WHEN v_result='created' THEN 'campaign_sub_agent_linked' ELSE 'campaign_sub_agent_link_noop' END,
    'agent_subagents', p_user_id,
    jsonb_build_object('result', v_result,'registration_id', v_reg.id,
      'campaign_link_id', v_link.id,'campaign_id', v_reg.campaign_id,
      'parent_agent_id', v_link.agent_id,'short_code', v_link.short_code,
      'reason', 'Campaign attribution converted to formal agent_subagents relationship.')
  );

  RETURN jsonb_build_object('status','ok','result', v_result,'parent_agent_id', v_link.agent_id,'registration_id', v_reg.id);
END $$;

GRANT EXECUTE ON FUNCTION public.link_campaign_sub_agent(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_campaign_attribution(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_attr public.campaign_attributions;
  v_link public.recruitment_campaign_links;
  v_camp_status public.recruitment_campaign_status;
  v_is_sub boolean;
  v_existing_reg uuid;
  v_completed_by_this_user uuid;
  v_link_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('status','auth_required'); END IF;
  IF p_token IS NULL THEN RETURN jsonb_build_object('status','invalid_token'); END IF;

  SELECT * INTO v_attr FROM public.campaign_attributions WHERE attribution_token = p_token;
  IF v_attr.id IS NULL THEN RETURN jsonb_build_object('status','invalid_token'); END IF;

  IF v_attr.status = 'registration_completed' AND v_attr.registered_user_id = v_uid THEN
    PERFORM public.link_campaign_sub_agent(v_uid);
    RETURN jsonb_build_object('status','already_completed','attribution_id',v_attr.id);
  END IF;
  IF v_attr.status = 'registration_completed' THEN
    RETURN jsonb_build_object('status','already_completed_other_user');
  END IF;
  IF v_attr.expires_at <= now() THEN RETURN jsonb_build_object('status','expired'); END IF;

  SELECT * INTO v_link FROM public.recruitment_campaign_links WHERE id = v_attr.campaign_link_id;
  IF v_link.id IS NULL OR v_link.status <> 'active' THEN RETURN jsonb_build_object('status','link_inactive'); END IF;
  SELECT status INTO v_camp_status FROM public.recruitment_campaigns WHERE id = v_attr.campaign_id;
  IF v_camp_status <> 'active' THEN RETURN jsonb_build_object('status','campaign_inactive'); END IF;

  IF v_uid = v_attr.referring_agent_id THEN
    UPDATE public.campaign_attributions SET status='invalidated' WHERE id=v_attr.id;
    RETURN jsonb_build_object('status','self_referral_blocked');
  END IF;

  SELECT id INTO v_existing_reg FROM public.recruitment_campaign_registrations WHERE registered_user_id = v_uid;
  IF v_existing_reg IS NOT NULL THEN
    UPDATE public.campaign_attributions
       SET status='existing_user', locked_at = COALESCE(locked_at, now()) WHERE id = v_attr.id;
    INSERT INTO public.campaign_attribution_audit_logs(attribution_id, action, reason, actor_type, actor_id)
    VALUES (v_attr.id,'duplicate_registration_detected','user has prior attribution','user',v_uid);
    PERFORM public.link_campaign_sub_agent(v_uid);
    RETURN jsonb_build_object('status','already_attributed','registration_id',v_existing_reg);
  END IF;

  v_is_sub := public.has_role(v_uid,'agent');

  INSERT INTO public.recruitment_campaign_registrations(
    campaign_link_id, campaign_id, agent_id, registered_user_id,
    location_id, selected_source, is_sub_agent, qualification_status
  ) VALUES (
    v_link.id, v_link.campaign_id, v_link.agent_id, v_uid,
    v_link.location_id, v_link.selected_source, v_is_sub,
    CASE WHEN v_is_sub THEN 'active' ELSE 'registered' END
  ) RETURNING id INTO v_completed_by_this_user;

  UPDATE public.recruitment_campaign_links SET total_registrations = total_registrations + 1 WHERE id = v_link.id;

  IF v_attr.anonymous_visitor_id IS NOT NULL THEN
    UPDATE public.recruitment_campaign_clicks
       SET converted_to_registration = true
     WHERE campaign_link_id = v_link.id AND visitor_id = v_attr.anonymous_visitor_id;
  END IF;

  BEGIN
    UPDATE public.profiles SET referrer_id = v_link.agent_id
     WHERE id = v_uid AND referrer_id IS NULL;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  UPDATE public.campaign_attributions
     SET status='registration_completed', registration_completed_at = now(),
         locked_at = COALESCE(locked_at, now()), registered_user_id = v_uid
   WHERE id = v_attr.id;

  INSERT INTO public.campaign_attribution_audit_logs(attribution_id, action, reason, actor_type, actor_id)
  VALUES (v_attr.id,'registration_completed','signup finalized','user',v_uid);

  DELETE FROM public.sub_agent_registration_drafts WHERE attribution_id = v_attr.id;

  v_link_result := public.link_campaign_sub_agent(v_uid);

  RETURN jsonb_build_object('status','ok','attribution_id', v_attr.id,'link_id', v_link.id,
    'agent_id', v_link.agent_id,'is_sub_agent', v_is_sub,'sub_agent_link', v_link_result);
END $function$;

CREATE OR REPLACE FUNCTION public.attach_campaign_registration(p_short_code text, p_visitor_id text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_link public.recruitment_campaign_links;
  v_camp_status public.recruitment_campaign_status;
  v_is_sub boolean;
  v_existing uuid;
  v_link_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;

  SELECT * INTO v_link FROM public.recruitment_campaign_links WHERE short_code = p_short_code;
  IF v_link.id IS NULL OR v_link.status <> 'active' THEN RETURN jsonb_build_object('status','link_inactive'); END IF;
  SELECT status INTO v_camp_status FROM public.recruitment_campaigns WHERE id = v_link.campaign_id;
  IF v_camp_status <> 'active' THEN RETURN jsonb_build_object('status','campaign_inactive'); END IF;
  IF v_uid = v_link.agent_id THEN RETURN jsonb_build_object('status','self_referral_blocked'); END IF;

  SELECT id INTO v_existing FROM public.recruitment_campaign_registrations WHERE registered_user_id = v_uid;
  IF v_existing IS NOT NULL THEN
    PERFORM public.link_campaign_sub_agent(v_uid);
    RETURN jsonb_build_object('status','already_attributed','registration_id',v_existing);
  END IF;

  v_is_sub := public.has_role(v_uid,'agent');

  INSERT INTO public.recruitment_campaign_registrations(
    campaign_link_id, campaign_id, agent_id, registered_user_id,
    location_id, selected_source, is_sub_agent, qualification_status
  ) VALUES (
    v_link.id, v_link.campaign_id, v_link.agent_id, v_uid,
    v_link.location_id, v_link.selected_source, v_is_sub,
    CASE WHEN v_is_sub THEN 'active' ELSE 'registered' END
  );

  UPDATE public.recruitment_campaign_links SET total_registrations = total_registrations + 1 WHERE id = v_link.id;

  IF p_visitor_id IS NOT NULL THEN
    UPDATE public.recruitment_campaign_clicks
       SET converted_to_registration = true
     WHERE campaign_link_id = v_link.id AND visitor_id = p_visitor_id;
  END IF;

  BEGIN
    UPDATE public.profiles SET referrer_id = v_link.agent_id
     WHERE id = v_uid AND referrer_id IS NULL;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  v_link_result := public.link_campaign_sub_agent(v_uid);

  RETURN jsonb_build_object('status','ok','link_id',v_link.id,'agent_id',v_link.agent_id,'is_sub_agent',v_is_sub,'sub_agent_link',v_link_result);
END $function$;
