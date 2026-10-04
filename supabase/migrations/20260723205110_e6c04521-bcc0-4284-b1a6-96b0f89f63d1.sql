
-- 1. Campaign attribution window
ALTER TABLE public.recruitment_campaigns
  ADD COLUMN IF NOT EXISTS attribution_window_days integer NOT NULL DEFAULT 30;

-- 2. Enum for attribution status
DO $$ BEGIN
  CREATE TYPE public.campaign_attribution_status AS ENUM (
    'active','registration_started','registration_completed',
    'expired','invalidated','duplicate','existing_user'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.sub_agent_draft_status AS ENUM (
    'started','awaiting_otp','verified','completed','expired','abandoned'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. campaign_attributions
CREATE TABLE IF NOT EXISTS public.campaign_attributions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  attribution_token text NOT NULL UNIQUE,
  campaign_link_id uuid NOT NULL REFERENCES public.recruitment_campaign_links(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.recruitment_campaigns(id) ON DELETE CASCADE,
  referring_agent_id uuid NOT NULL,
  campaign_location_id uuid,
  selected_source public.recruitment_source,
  link_type public.recruitment_link_type,
  placement_name text,
  anonymous_visitor_id text,
  initial_click_id uuid,
  latest_click_id uuid,
  status public.campaign_attribution_status NOT NULL DEFAULT 'active',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  locked_at timestamptz,
  registration_started_at timestamptz,
  registration_completed_at timestamptz,
  registered_user_id uuid,
  registered_sub_agent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.campaign_attributions TO authenticated;
GRANT ALL ON public.campaign_attributions TO service_role;
ALTER TABLE public.campaign_attributions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_camp_attr_link ON public.campaign_attributions(campaign_link_id);
CREATE INDEX IF NOT EXISTS idx_camp_attr_campaign ON public.campaign_attributions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_camp_attr_agent ON public.campaign_attributions(referring_agent_id);
CREATE INDEX IF NOT EXISTS idx_camp_attr_visitor ON public.campaign_attributions(anonymous_visitor_id);
CREATE INDEX IF NOT EXISTS idx_camp_attr_user ON public.campaign_attributions(registered_user_id);
CREATE INDEX IF NOT EXISTS idx_camp_attr_status ON public.campaign_attributions(status);
CREATE INDEX IF NOT EXISTS idx_camp_attr_expires ON public.campaign_attributions(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_camp_attr_completed_user
  ON public.campaign_attributions(registered_user_id)
  WHERE status = 'registration_completed' AND registered_user_id IS NOT NULL;

CREATE POLICY "camp_attr_agent_read" ON public.campaign_attributions
  FOR SELECT TO authenticated
  USING (
    auth.uid() = referring_agent_id
    OR auth.uid() = registered_user_id
    OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'cto')
  );

-- 4. sub_agent_registration_drafts (server-only, sensitive)
CREATE TABLE IF NOT EXISTS public.sub_agent_registration_drafts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  attribution_id uuid NOT NULL REFERENCES public.campaign_attributions(id) ON DELETE CASCADE,
  anonymous_visitor_id text,
  phone_number text,
  current_step text,
  form_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_status text,
  status public.sub_agent_draft_status NOT NULL DEFAULT 'started',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.sub_agent_registration_drafts TO service_role;
ALTER TABLE public.sub_agent_registration_drafts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_sadraft_attr ON public.sub_agent_registration_drafts(attribution_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sadraft_attr ON public.sub_agent_registration_drafts(attribution_id);
CREATE INDEX IF NOT EXISTS idx_sadraft_phone ON public.sub_agent_registration_drafts(phone_number);

-- Drafts read only via RPC; deny direct SELECT to anon/authenticated by omission.

-- 5. Attribution audit log
CREATE TABLE IF NOT EXISTS public.campaign_attribution_audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  attribution_id uuid NOT NULL REFERENCES public.campaign_attributions(id) ON DELETE CASCADE,
  action text NOT NULL,
  previous_campaign_link_id uuid,
  new_campaign_link_id uuid,
  previous_agent_id uuid,
  new_agent_id uuid,
  reason text,
  actor_type text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.campaign_attribution_audit_logs TO authenticated;
GRANT ALL ON public.campaign_attribution_audit_logs TO service_role;
ALTER TABLE public.campaign_attribution_audit_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_camp_attr_audit_attr ON public.campaign_attribution_audit_logs(attribution_id);

CREATE POLICY "camp_attr_audit_read" ON public.campaign_attribution_audit_logs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.campaign_attributions ca
      WHERE ca.id = attribution_id
        AND (ca.referring_agent_id = auth.uid() OR ca.registered_user_id = auth.uid())
    )
    OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'cto')
  );

-- 6. updated_at triggers
CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_camp_attr_upd ON public.campaign_attributions;
CREATE TRIGGER trg_camp_attr_upd BEFORE UPDATE ON public.campaign_attributions
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

DROP TRIGGER IF EXISTS trg_sadraft_upd ON public.sub_agent_registration_drafts;
CREATE TRIGGER trg_sadraft_upd BEFORE UPDATE ON public.sub_agent_registration_drafts
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- 7. RPCs
-- 7a. Create or refresh attribution (public/anon callable)
CREATE OR REPLACE FUNCTION public.create_or_refresh_campaign_attribution(
  p_short_code text,
  p_visitor_id text DEFAULT NULL,
  p_prior_token text DEFAULT NULL,
  p_click_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_link public.recruitment_campaign_links;
  v_camp_status public.recruitment_campaign_status;
  v_window integer;
  v_attr public.campaign_attributions;
  v_prior public.campaign_attributions;
  v_token text;
BEGIN
  IF p_short_code IS NULL THEN RETURN jsonb_build_object('status','invalid'); END IF;

  SELECT * INTO v_link FROM public.recruitment_campaign_links WHERE short_code = p_short_code;
  IF v_link.id IS NULL THEN RETURN jsonb_build_object('status','invalid'); END IF;
  IF v_link.status <> 'active' THEN RETURN jsonb_build_object('status','link_inactive'); END IF;

  SELECT status, attribution_window_days INTO v_camp_status, v_window
    FROM public.recruitment_campaigns WHERE id = v_link.campaign_id;
  IF v_camp_status <> 'active' THEN RETURN jsonb_build_object('status','campaign_inactive'); END IF;
  IF v_window IS NULL OR v_window < 1 THEN v_window := 30; END IF;

  -- Prior attribution check (locked = don't switch agent)
  IF p_prior_token IS NOT NULL THEN
    SELECT * INTO v_prior FROM public.campaign_attributions WHERE attribution_token = p_prior_token;
    IF v_prior.id IS NOT NULL
       AND v_prior.status IN ('active','registration_started')
       AND v_prior.expires_at > now()
       AND v_prior.locked_at IS NOT NULL
    THEN
      -- Locked: keep same attribution, only record this as a returning interaction
      UPDATE public.campaign_attributions
         SET last_seen_at = now(),
             latest_click_id = COALESCE(p_click_id, latest_click_id)
       WHERE id = v_prior.id;
      RETURN jsonb_build_object(
        'status','ok',
        'attribution_token', v_prior.attribution_token,
        'locked', true,
        'campaign_link_id', v_prior.campaign_link_id,
        'campaign_id', v_prior.campaign_id,
        'referring_agent_id', v_prior.referring_agent_id,
        'campaign_location_id', v_prior.campaign_location_id,
        'selected_source', v_prior.selected_source,
        'link_type', v_prior.link_type,
        'canonical_slug', v_link.location_slug,
        'short_code', v_link.short_code
      );
    END IF;
    -- Unlocked prior for the SAME link: reuse (idempotent refresh)
    IF v_prior.id IS NOT NULL
       AND v_prior.campaign_link_id = v_link.id
       AND v_prior.status IN ('active','registration_started')
       AND v_prior.expires_at > now()
    THEN
      UPDATE public.campaign_attributions
         SET last_seen_at = now(),
             latest_click_id = COALESCE(p_click_id, latest_click_id),
             anonymous_visitor_id = COALESCE(p_visitor_id, anonymous_visitor_id),
             expires_at = now() + (v_window || ' days')::interval
       WHERE id = v_prior.id
       RETURNING * INTO v_attr;
      RETURN jsonb_build_object(
        'status','ok',
        'attribution_token', v_attr.attribution_token,
        'locked', false,
        'campaign_link_id', v_attr.campaign_link_id,
        'campaign_id', v_attr.campaign_id,
        'referring_agent_id', v_attr.referring_agent_id,
        'campaign_location_id', v_attr.campaign_location_id,
        'selected_source', v_attr.selected_source,
        'link_type', v_attr.link_type,
        'canonical_slug', v_link.location_slug,
        'short_code', v_link.short_code
      );
    END IF;
    -- Unlocked prior for a DIFFERENT link -> replace, audit it
    IF v_prior.id IS NOT NULL
       AND v_prior.status IN ('active','registration_started')
       AND v_prior.expires_at > now()
       AND v_prior.campaign_link_id <> v_link.id
    THEN
      UPDATE public.campaign_attributions
         SET status = 'invalidated', updated_at = now()
       WHERE id = v_prior.id;
      INSERT INTO public.campaign_attribution_audit_logs(
        attribution_id, action, previous_campaign_link_id, new_campaign_link_id,
        previous_agent_id, new_agent_id, reason, actor_type
      ) VALUES (
        v_prior.id,'attribution_updated', v_prior.campaign_link_id, v_link.id,
        v_prior.referring_agent_id, v_link.agent_id,
        'latest-valid-link-before-lock','anon'
      );
    END IF;
  END IF;

  -- Create new attribution
  v_token := encode(gen_random_bytes(24), 'base64');
  v_token := replace(replace(replace(v_token, '+','-'),'/','_'),'=','');

  INSERT INTO public.campaign_attributions(
    attribution_token, campaign_link_id, campaign_id, referring_agent_id,
    campaign_location_id, selected_source, link_type, placement_name,
    anonymous_visitor_id, initial_click_id, latest_click_id,
    status, first_seen_at, last_seen_at, expires_at
  ) VALUES (
    v_token, v_link.id, v_link.campaign_id, v_link.agent_id,
    v_link.location_id, v_link.selected_source, v_link.link_type, v_link.placement_name,
    p_visitor_id, p_click_id, p_click_id,
    'active', now(), now(), now() + (v_window || ' days')::interval
  ) RETURNING * INTO v_attr;

  INSERT INTO public.campaign_attribution_audit_logs(
    attribution_id, action, new_campaign_link_id, new_agent_id, reason, actor_type
  ) VALUES (
    v_attr.id, 'attribution_created', v_link.id, v_link.agent_id,'campaign-link-opened','anon'
  );

  RETURN jsonb_build_object(
    'status','ok',
    'attribution_token', v_attr.attribution_token,
    'locked', false,
    'campaign_link_id', v_attr.campaign_link_id,
    'campaign_id', v_attr.campaign_id,
    'referring_agent_id', v_attr.referring_agent_id,
    'campaign_location_id', v_attr.campaign_location_id,
    'selected_source', v_attr.selected_source,
    'link_type', v_attr.link_type,
    'canonical_slug', v_link.location_slug,
    'short_code', v_link.short_code
  );
END $$;

REVOKE ALL ON FUNCTION public.create_or_refresh_campaign_attribution(text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_or_refresh_campaign_attribution(text,text,text,uuid) TO anon, authenticated, service_role;

-- 7b. Restore attribution
CREATE OR REPLACE FUNCTION public.restore_campaign_attribution(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attr public.campaign_attributions;
  v_link public.recruitment_campaign_links;
  v_camp_status public.recruitment_campaign_status;
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

  RETURN jsonb_build_object(
    'status','ok',
    'attribution_token', v_attr.attribution_token,
    'locked', v_attr.locked_at IS NOT NULL,
    'campaign_link_id', v_attr.campaign_link_id,
    'campaign_id', v_attr.campaign_id,
    'referring_agent_id', v_attr.referring_agent_id,
    'campaign_location_id', v_attr.campaign_location_id,
    'selected_source', v_attr.selected_source,
    'link_type', v_attr.link_type,
    'canonical_slug', v_link.location_slug,
    'short_code', v_link.short_code
  );
END $$;

REVOKE ALL ON FUNCTION public.restore_campaign_attribution(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_campaign_attribution(text) TO anon, authenticated, service_role;

-- 7c. Upsert draft
CREATE OR REPLACE FUNCTION public.upsert_sub_agent_registration_draft(
  p_token text,
  p_current_step text,
  p_form_data jsonb DEFAULT '{}'::jsonb,
  p_phone_number text DEFAULT NULL,
  p_status public.sub_agent_draft_status DEFAULT 'started',
  p_verification_status text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attr public.campaign_attributions;
  v_draft public.sub_agent_registration_drafts;
  v_safe_form jsonb;
BEGIN
  SELECT * INTO v_attr FROM public.campaign_attributions WHERE attribution_token = p_token;
  IF v_attr.id IS NULL THEN RETURN jsonb_build_object('status','invalid_token'); END IF;
  IF v_attr.status = 'registration_completed' THEN RETURN jsonb_build_object('status','already_completed'); END IF;
  IF v_attr.expires_at <= now() THEN RETURN jsonb_build_object('status','expired'); END IF;

  -- Strip sensitive fields from form_data defensively
  v_safe_form := COALESCE(p_form_data,'{}'::jsonb)
                 - 'password' - 'confirm_password' - 'otp' - 'otp_code' - 'access_token' - 'refresh_token';

  SELECT * INTO v_draft FROM public.sub_agent_registration_drafts WHERE attribution_id = v_attr.id;
  IF v_draft.id IS NULL THEN
    INSERT INTO public.sub_agent_registration_drafts(
      attribution_id, anonymous_visitor_id, phone_number, current_step, form_data,
      verification_status, status, expires_at
    ) VALUES (
      v_attr.id, v_attr.anonymous_visitor_id, p_phone_number, p_current_step, v_safe_form,
      p_verification_status, p_status, v_attr.expires_at
    ) RETURNING * INTO v_draft;
  ELSE
    UPDATE public.sub_agent_registration_drafts
       SET current_step = COALESCE(p_current_step, current_step),
           form_data = COALESCE(v_safe_form, form_data),
           phone_number = COALESCE(p_phone_number, phone_number),
           verification_status = COALESCE(p_verification_status, verification_status),
           status = p_status
     WHERE id = v_draft.id
     RETURNING * INTO v_draft;
  END IF;

  -- Track registration_started on attribution
  IF v_attr.status = 'active' THEN
    UPDATE public.campaign_attributions
       SET status='registration_started',
           registration_started_at = COALESCE(registration_started_at, now())
     WHERE id = v_attr.id AND status='active';
    INSERT INTO public.campaign_attribution_audit_logs(
      attribution_id, action, reason, actor_type
    ) VALUES (v_attr.id,'registration_started','draft-upsert','anon');
  END IF;

  RETURN jsonb_build_object('status','ok','draft_id',v_draft.id,'current_step',v_draft.current_step);
END $$;

REVOKE ALL ON FUNCTION public.upsert_sub_agent_registration_draft(text,text,jsonb,text,public.sub_agent_draft_status,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_sub_agent_registration_draft(text,text,jsonb,text,public.sub_agent_draft_status,text) TO anon, authenticated, service_role;

-- 7d. Complete attribution (authenticated) — reuses existing registration path
CREATE OR REPLACE FUNCTION public.complete_campaign_attribution(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_attr public.campaign_attributions;
  v_link public.recruitment_campaign_links;
  v_camp_status public.recruitment_campaign_status;
  v_is_sub boolean;
  v_existing_reg uuid;
  v_completed_by_this_user uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('status','auth_required'); END IF;
  IF p_token IS NULL THEN RETURN jsonb_build_object('status','invalid_token'); END IF;

  SELECT * INTO v_attr FROM public.campaign_attributions WHERE attribution_token = p_token;
  IF v_attr.id IS NULL THEN RETURN jsonb_build_object('status','invalid_token'); END IF;

  -- Idempotency: this user already completed under this attribution
  IF v_attr.status = 'registration_completed' AND v_attr.registered_user_id = v_uid THEN
    RETURN jsonb_build_object('status','already_completed','attribution_id',v_attr.id);
  END IF;
  IF v_attr.status = 'registration_completed' THEN
    RETURN jsonb_build_object('status','already_completed_other_user');
  END IF;
  IF v_attr.expires_at <= now() THEN RETURN jsonb_build_object('status','expired'); END IF;

  SELECT * INTO v_link FROM public.recruitment_campaign_links WHERE id = v_attr.campaign_link_id;
  IF v_link.id IS NULL OR v_link.status <> 'active' THEN
    RETURN jsonb_build_object('status','link_inactive');
  END IF;
  SELECT status INTO v_camp_status FROM public.recruitment_campaigns WHERE id = v_attr.campaign_id;
  IF v_camp_status <> 'active' THEN RETURN jsonb_build_object('status','campaign_inactive'); END IF;

  IF v_uid = v_attr.referring_agent_id THEN
    UPDATE public.campaign_attributions SET status='invalidated' WHERE id=v_attr.id;
    RETURN jsonb_build_object('status','self_referral_blocked');
  END IF;

  -- Existing registration for this user under ANY link
  SELECT id INTO v_existing_reg
    FROM public.recruitment_campaign_registrations
   WHERE registered_user_id = v_uid;

  IF v_existing_reg IS NOT NULL THEN
    UPDATE public.campaign_attributions
       SET status='existing_user', locked_at = COALESCE(locked_at, now())
     WHERE id = v_attr.id;
    INSERT INTO public.campaign_attribution_audit_logs(
      attribution_id, action, reason, actor_type, actor_id
    ) VALUES (v_attr.id,'duplicate_registration_detected','user has prior attribution','user',v_uid);
    RETURN jsonb_build_object('status','already_attributed','registration_id',v_existing_reg);
  END IF;

  v_is_sub := public.has_role(v_uid,'agent');

  INSERT INTO public.recruitment_campaign_registrations(
    campaign_link_id, campaign_id, agent_id, registered_user_id,
    location_id, selected_source, is_sub_agent,
    qualification_status
  ) VALUES (
    v_link.id, v_link.campaign_id, v_link.agent_id, v_uid,
    v_link.location_id, v_link.selected_source, v_is_sub,
    CASE WHEN v_is_sub THEN 'active' ELSE 'registered' END
  ) RETURNING id INTO v_completed_by_this_user;

  UPDATE public.recruitment_campaign_links
     SET total_registrations = total_registrations + 1,
         total_sub_agent_registrations = total_sub_agent_registrations + CASE WHEN v_is_sub THEN 1 ELSE 0 END
   WHERE id = v_link.id;

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
     SET status='registration_completed',
         registration_completed_at = now(),
         locked_at = COALESCE(locked_at, now()),
         registered_user_id = v_uid
   WHERE id = v_attr.id;

  INSERT INTO public.campaign_attribution_audit_logs(
    attribution_id, action, reason, actor_type, actor_id
  ) VALUES (v_attr.id,'registration_completed','signup finalized','user',v_uid);

  -- Cleanup transient draft data
  DELETE FROM public.sub_agent_registration_drafts WHERE attribution_id = v_attr.id;

  RETURN jsonb_build_object(
    'status','ok',
    'attribution_id', v_attr.id,
    'link_id', v_link.id,
    'agent_id', v_link.agent_id,
    'is_sub_agent', v_is_sub
  );
END $$;

REVOKE ALL ON FUNCTION public.complete_campaign_attribution(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_campaign_attribution(text) TO authenticated, service_role;

-- 7e. Lock attribution (called after OTP verified)
CREATE OR REPLACE FUNCTION public.lock_campaign_attribution(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_attr public.campaign_attributions;
BEGIN
  SELECT * INTO v_attr FROM public.campaign_attributions WHERE attribution_token = p_token;
  IF v_attr.id IS NULL THEN RETURN jsonb_build_object('status','invalid_token'); END IF;
  IF v_attr.locked_at IS NOT NULL THEN RETURN jsonb_build_object('status','already_locked'); END IF;
  IF v_attr.status IN ('registration_completed','invalidated','expired','existing_user','duplicate') THEN
    RETURN jsonb_build_object('status', v_attr.status::text);
  END IF;
  UPDATE public.campaign_attributions SET locked_at = now() WHERE id = v_attr.id;
  INSERT INTO public.campaign_attribution_audit_logs(
    attribution_id, action, reason, actor_type
  ) VALUES (v_attr.id,'attribution_locked','identity-step-reached','anon');
  RETURN jsonb_build_object('status','ok');
END $$;

REVOKE ALL ON FUNCTION public.lock_campaign_attribution(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_campaign_attribution(text) TO anon, authenticated, service_role;

-- 8. Backfill: create historical attributions from existing completed registrations
INSERT INTO public.campaign_attributions(
  attribution_token, campaign_link_id, campaign_id, referring_agent_id,
  campaign_location_id, selected_source,
  status, first_seen_at, last_seen_at, expires_at,
  registration_started_at, registration_completed_at,
  registered_user_id, locked_at
)
SELECT
  'legacy_' || encode(gen_random_bytes(18),'hex'),
  r.campaign_link_id, r.campaign_id, r.agent_id,
  r.location_id, r.selected_source,
  'registration_completed', r.registered_at, r.registered_at, r.registered_at + interval '30 days',
  r.registered_at, r.registered_at,
  r.registered_user_id, r.registered_at
FROM public.recruitment_campaign_registrations r
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaign_attributions ca
   WHERE ca.registered_user_id = r.registered_user_id
     AND ca.status = 'registration_completed'
)
ON CONFLICT DO NOTHING;
