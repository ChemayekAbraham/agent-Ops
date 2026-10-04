
-- ==========================================================================
-- Field Recruitment Campaign Tracking — Phase One
-- ==========================================================================

-- Enums
DO $$ BEGIN
  CREATE TYPE public.recruitment_campaign_status AS ENUM ('draft','active','paused','completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.recruitment_source AS ENUM (
    'whatsapp','facebook','tiktok','sms','qr_sticker','printed_poster',
    'direct_link','agent_assisted','other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.recruitment_link_type AS ENUM (
    'general_campaign_link','qr_sticker','printed_poster','assisted_registration','social_share'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.recruitment_link_status AS ENUM ('active','disabled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.recruitment_registration_status AS ENUM (
    'registered','active','one_verified_house','two_verified_houses','reward_qualified','reward_paid'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------ locations
CREATE TABLE IF NOT EXISTS public.recruitment_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country text NOT NULL DEFAULT 'Uganda',
  region text,
  district text NOT NULL,
  city text,
  division text,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_locations_district ON public.recruitment_locations(district);

GRANT SELECT ON public.recruitment_locations TO authenticated;
GRANT ALL ON public.recruitment_locations TO service_role;
ALTER TABLE public.recruitment_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rec_loc_read_all_auth" ON public.recruitment_locations
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "rec_loc_admin_write" ON public.recruitment_locations
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'coo'))
  WITH CHECK (public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'coo'));

-- ------------------------------------------------------------------ campaigns
CREATE TABLE IF NOT EXISTS public.recruitment_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  objective text,
  start_date date NOT NULL DEFAULT CURRENT_DATE,
  end_date date,
  status public.recruitment_campaign_status NOT NULL DEFAULT 'draft',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_campaigns_status ON public.recruitment_campaigns(status);

GRANT SELECT ON public.recruitment_campaigns TO authenticated;
GRANT ALL ON public.recruitment_campaigns TO service_role;
ALTER TABLE public.recruitment_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rec_camp_active_read" ON public.recruitment_campaigns
  FOR SELECT TO authenticated USING (status IN ('active','paused','completed'));
CREATE POLICY "rec_camp_admin_all" ON public.recruitment_campaigns
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'coo'))
  WITH CHECK (public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'coo'));

-- ------------------------------------------------------------------ campaign_agents
CREATE TABLE IF NOT EXISTS public.recruitment_campaign_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.recruitment_campaigns(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_rec_ca_agent ON public.recruitment_campaign_agents(agent_id);

GRANT SELECT, INSERT ON public.recruitment_campaign_agents TO authenticated;
GRANT ALL ON public.recruitment_campaign_agents TO service_role;
ALTER TABLE public.recruitment_campaign_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rec_ca_own_read" ON public.recruitment_campaign_agents
  FOR SELECT TO authenticated
  USING (auth.uid() = agent_id
    OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'coo'));
CREATE POLICY "rec_ca_self_join" ON public.recruitment_campaign_agents
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = agent_id);

-- ------------------------------------------------------------------ campaign_links
CREATE TABLE IF NOT EXISTS public.recruitment_campaign_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code text NOT NULL UNIQUE,
  campaign_id uuid NOT NULL REFERENCES public.recruitment_campaigns(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES public.recruitment_locations(id),
  location_slug text NOT NULL,
  selected_source public.recruitment_source NOT NULL,
  link_type public.recruitment_link_type NOT NULL DEFAULT 'general_campaign_link',
  placement_name text,
  status public.recruitment_link_status NOT NULL DEFAULT 'active',
  first_click_at timestamptz,
  expires_at timestamptz,
  total_clicks integer NOT NULL DEFAULT 0,
  unique_clicks integer NOT NULL DEFAULT 0,
  total_registrations integer NOT NULL DEFAULT 0,
  total_sub_agent_registrations integer NOT NULL DEFAULT 0,
  qualified_sub_agents integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_links_agent_created ON public.recruitment_campaign_links(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rec_links_campaign ON public.recruitment_campaign_links(campaign_id);
CREATE INDEX IF NOT EXISTS idx_rec_links_location ON public.recruitment_campaign_links(location_id);
CREATE INDEX IF NOT EXISTS idx_rec_links_status ON public.recruitment_campaign_links(status);

GRANT SELECT ON public.recruitment_campaign_links TO authenticated;
GRANT ALL ON public.recruitment_campaign_links TO service_role;
ALTER TABLE public.recruitment_campaign_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rec_links_own_read" ON public.recruitment_campaign_links
  FOR SELECT TO authenticated
  USING (auth.uid() = agent_id
    OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'coo'));

-- ------------------------------------------------------------------ clicks
CREATE TABLE IF NOT EXISTS public.recruitment_campaign_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_link_id uuid NOT NULL REFERENCES public.recruitment_campaign_links(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  visitor_id text,
  referrer text,
  browser text,
  operating_system text,
  device_category text,
  ip_hash text,
  approximate_location jsonb,
  converted_to_registration boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_clicks_link_created ON public.recruitment_campaign_clicks(campaign_link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rec_clicks_agent ON public.recruitment_campaign_clicks(agent_id);
CREATE INDEX IF NOT EXISTS idx_rec_clicks_visitor ON public.recruitment_campaign_clicks(campaign_link_id, visitor_id);

GRANT SELECT ON public.recruitment_campaign_clicks TO authenticated;
GRANT ALL ON public.recruitment_campaign_clicks TO service_role;
ALTER TABLE public.recruitment_campaign_clicks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rec_clicks_own_read" ON public.recruitment_campaign_clicks
  FOR SELECT TO authenticated
  USING (auth.uid() = agent_id
    OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'coo'));

-- ------------------------------------------------------------------ registrations
CREATE TABLE IF NOT EXISTS public.recruitment_campaign_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_link_id uuid NOT NULL REFERENCES public.recruitment_campaign_links(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  registered_user_id uuid NOT NULL UNIQUE,
  location_id uuid,
  selected_source public.recruitment_source,
  registered_at timestamptz NOT NULL DEFAULT now(),
  qualification_status public.recruitment_registration_status NOT NULL DEFAULT 'registered',
  is_sub_agent boolean NOT NULL DEFAULT false,
  verified_houses_count integer NOT NULL DEFAULT 0,
  first_verified_house_at timestamptz,
  second_verified_house_at timestamptz,
  third_verified_house_at timestamptz,
  reward_qualified_at timestamptz,
  reward_paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_rec_reg_agent ON public.recruitment_campaign_registrations(agent_id);
CREATE INDEX IF NOT EXISTS idx_rec_reg_link ON public.recruitment_campaign_registrations(campaign_link_id);
CREATE INDEX IF NOT EXISTS idx_rec_reg_campaign ON public.recruitment_campaign_registrations(campaign_id);
CREATE INDEX IF NOT EXISTS idx_rec_reg_user ON public.recruitment_campaign_registrations(registered_user_id);

GRANT SELECT ON public.recruitment_campaign_registrations TO authenticated;
GRANT ALL ON public.recruitment_campaign_registrations TO service_role;
ALTER TABLE public.recruitment_campaign_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rec_reg_own_read" ON public.recruitment_campaign_registrations
  FOR SELECT TO authenticated
  USING (auth.uid() = agent_id
    OR auth.uid() = registered_user_id
    OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'coo'));

-- ------------------------------------------------------------------ audit
CREATE TABLE IF NOT EXISTS public.recruitment_campaign_link_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_link_id uuid NOT NULL REFERENCES public.recruitment_campaign_links(id) ON DELETE CASCADE,
  action text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
CREATE INDEX IF NOT EXISTS idx_rec_audit_link ON public.recruitment_campaign_link_audit_logs(campaign_link_id, changed_at DESC);

GRANT SELECT ON public.recruitment_campaign_link_audit_logs TO authenticated;
GRANT ALL ON public.recruitment_campaign_link_audit_logs TO service_role;
ALTER TABLE public.recruitment_campaign_link_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rec_audit_admin_read" ON public.recruitment_campaign_link_audit_logs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'coo'));

-- Timestamps
CREATE OR REPLACE FUNCTION public.recruitment_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_rec_camp_upd ON public.recruitment_campaigns;
CREATE TRIGGER trg_rec_camp_upd BEFORE UPDATE ON public.recruitment_campaigns
FOR EACH ROW EXECUTE FUNCTION public.recruitment_touch_updated_at();

DROP TRIGGER IF EXISTS trg_rec_links_upd ON public.recruitment_campaign_links;
CREATE TRIGGER trg_rec_links_upd BEFORE UPDATE ON public.recruitment_campaign_links
FOR EACH ROW EXECUTE FUNCTION public.recruitment_touch_updated_at();

-- Seed locations (idempotent)
INSERT INTO public.recruitment_locations (country, region, district, slug, display_name) VALUES
  ('Uganda','Central','Kampala','kampala','Kampala'),
  ('Uganda','Central','Wakiso','wakiso','Wakiso'),
  ('Uganda','Central','Mukono','mukono','Mukono'),
  ('Uganda','Central','Masaka','masaka','Masaka'),
  ('Uganda','Eastern','Mbale','mbale','Mbale'),
  ('Uganda','Eastern','Jinja','jinja','Jinja'),
  ('Uganda','Eastern','Soroti','soroti','Soroti'),
  ('Uganda','Eastern','Tororo','tororo','Tororo'),
  ('Uganda','Western','Mbarara','mbarara','Mbarara'),
  ('Uganda','Western','Fort Portal','fort-portal','Fort Portal'),
  ('Uganda','Western','Hoima','hoima','Hoima'),
  ('Uganda','Western','Kabale','kabale','Kabale'),
  ('Uganda','Northern','Gulu','gulu','Gulu'),
  ('Uganda','Northern','Lira','lira','Lira'),
  ('Uganda','Northern','Arua','arua','Arua'),
  ('Uganda','Northern','Kitgum','kitgum','Kitgum')
ON CONFLICT (slug) DO NOTHING;

-- ==========================================================================
-- Short-code generator
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.generate_campaign_short_code()
RETURNS text LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  v_code text;
  v_i int;
BEGIN
  FOR attempt IN 1..10 LOOP
    v_code := '';
    FOR v_i IN 1..7 LOOP
      v_code := v_code || substr(v_alphabet, 1 + (floor(random() * length(v_alphabet)))::int, 1);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.recruitment_campaign_links WHERE short_code = v_code) THEN
      RETURN v_code;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'Could not allocate unique short code';
END $$;

-- ==========================================================================
-- create_campaign_link RPC
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.create_campaign_link(
  p_campaign_id uuid,
  p_location_id uuid,
  p_selected_source public.recruitment_source,
  p_link_type public.recruitment_link_type DEFAULT 'general_campaign_link',
  p_placement_name text DEFAULT NULL
) RETURNS public.recruitment_campaign_links
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_agent uuid := auth.uid();
  v_status public.recruitment_campaign_status;
  v_slug text;
  v_code text;
  v_row public.recruitment_campaign_links;
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;

  SELECT status INTO v_status FROM public.recruitment_campaigns WHERE id = p_campaign_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'campaign not found'; END IF;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'campaign not active'; END IF;

  SELECT slug INTO v_slug FROM public.recruitment_locations WHERE id = p_location_id AND is_active;
  IF v_slug IS NULL THEN RAISE EXCEPTION 'location not found'; END IF;

  -- Auto-join agent to campaign
  INSERT INTO public.recruitment_campaign_agents(campaign_id, agent_id)
  VALUES (p_campaign_id, v_agent)
  ON CONFLICT DO NOTHING;

  v_code := public.generate_campaign_short_code();

  INSERT INTO public.recruitment_campaign_links(
    short_code, campaign_id, agent_id, location_id, location_slug,
    selected_source, link_type, placement_name
  ) VALUES (
    v_code, p_campaign_id, v_agent, p_location_id, v_slug,
    p_selected_source, p_link_type, p_placement_name
  ) RETURNING * INTO v_row;

  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.create_campaign_link(uuid,uuid,public.recruitment_source,public.recruitment_link_type,text) TO authenticated;

-- ==========================================================================
-- Disable / edit link
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.disable_campaign_link(p_link_id uuid, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_agent uuid; v_uid uuid := auth.uid(); v_is_admin boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  v_is_admin := public.has_role(v_uid,'manager') OR public.has_role(v_uid,'cto') OR public.has_role(v_uid,'coo');
  SELECT agent_id INTO v_agent FROM public.recruitment_campaign_links WHERE id = p_link_id;
  IF v_agent IS NULL THEN RAISE EXCEPTION 'link not found'; END IF;
  IF NOT v_is_admin AND v_agent <> v_uid THEN RAISE EXCEPTION 'not permitted'; END IF;

  UPDATE public.recruitment_campaign_links SET status = 'disabled' WHERE id = p_link_id;

  INSERT INTO public.recruitment_campaign_link_audit_logs(campaign_link_id, action, new_value, changed_by, reason)
  VALUES (p_link_id, 'disable', jsonb_build_object('status','disabled'), v_uid, p_reason);
END $$;
GRANT EXECUTE ON FUNCTION public.disable_campaign_link(uuid,text) TO authenticated;

-- ==========================================================================
-- record_campaign_click (called by edge function via service_role)
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.record_campaign_click(
  p_short_code text,
  p_visitor_id text,
  p_referrer text DEFAULT NULL,
  p_browser text DEFAULT NULL,
  p_os text DEFAULT NULL,
  p_device text DEFAULT NULL,
  p_ip_hash text DEFAULT NULL,
  p_approx_location jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_link public.recruitment_campaign_links;
  v_camp_status public.recruitment_campaign_status;
  v_is_unique boolean := false;
BEGIN
  SELECT * INTO v_link FROM public.recruitment_campaign_links WHERE short_code = p_short_code;
  IF v_link.id IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF v_link.status <> 'active' THEN
    RETURN jsonb_build_object('status', v_link.status::text, 'link_id', v_link.id);
  END IF;

  SELECT status INTO v_camp_status FROM public.recruitment_campaigns WHERE id = v_link.campaign_id;
  IF v_camp_status <> 'active' THEN
    RETURN jsonb_build_object('status', 'campaign_' || v_camp_status::text, 'link_id', v_link.id);
  END IF;

  IF p_visitor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.recruitment_campaign_clicks
     WHERE campaign_link_id = v_link.id AND visitor_id = p_visitor_id
  ) THEN
    v_is_unique := true;
  END IF;

  INSERT INTO public.recruitment_campaign_clicks(
    campaign_link_id, campaign_id, agent_id, visitor_id, referrer,
    browser, operating_system, device_category, ip_hash, approximate_location
  ) VALUES (
    v_link.id, v_link.campaign_id, v_link.agent_id, p_visitor_id, p_referrer,
    p_browser, p_os, p_device, p_ip_hash, p_approx_location
  );

  UPDATE public.recruitment_campaign_links
     SET total_clicks   = total_clicks + 1,
         unique_clicks  = unique_clicks + CASE WHEN v_is_unique THEN 1 ELSE 0 END,
         first_click_at = COALESCE(first_click_at, now())
   WHERE id = v_link.id;

  RETURN jsonb_build_object(
    'status','ok',
    'link_id', v_link.id,
    'campaign_id', v_link.campaign_id,
    'agent_id', v_link.agent_id,
    'location_slug', v_link.location_slug,
    'selected_source', v_link.selected_source::text,
    'canonical_slug', v_link.location_slug
  );
END $$;
GRANT EXECUTE ON FUNCTION public.record_campaign_click(text,text,text,text,text,text,text,jsonb) TO service_role, authenticated;

-- ==========================================================================
-- resolve_campaign_short_code (read-only)
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.resolve_campaign_short_code(p_short_code text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'link_id', l.id,
    'campaign_id', l.campaign_id,
    'campaign_name', c.name,
    'agent_id', l.agent_id,
    'location_id', l.location_id,
    'location_slug', l.location_slug,
    'location_display', loc.display_name,
    'district', loc.district,
    'selected_source', l.selected_source::text,
    'link_type', l.link_type::text,
    'status', l.status::text,
    'campaign_status', c.status::text
  )
  FROM public.recruitment_campaign_links l
  JOIN public.recruitment_campaigns c ON c.id = l.campaign_id
  JOIN public.recruitment_locations loc ON loc.id = l.location_id
  WHERE l.short_code = p_short_code;
$$;
GRANT EXECUTE ON FUNCTION public.resolve_campaign_short_code(text) TO service_role, authenticated, anon;

-- ==========================================================================
-- attach_campaign_registration — called after user signup
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.attach_campaign_registration(
  p_short_code text,
  p_visitor_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_link public.recruitment_campaign_links;
  v_camp_status public.recruitment_campaign_status;
  v_is_sub boolean;
  v_existing uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;

  SELECT * INTO v_link FROM public.recruitment_campaign_links WHERE short_code = p_short_code;
  IF v_link.id IS NULL OR v_link.status <> 'active' THEN
    RETURN jsonb_build_object('status','link_inactive');
  END IF;
  SELECT status INTO v_camp_status FROM public.recruitment_campaigns WHERE id = v_link.campaign_id;
  IF v_camp_status <> 'active' THEN RETURN jsonb_build_object('status','campaign_inactive'); END IF;

  IF v_uid = v_link.agent_id THEN RETURN jsonb_build_object('status','self_referral_blocked'); END IF;

  SELECT id INTO v_existing FROM public.recruitment_campaign_registrations WHERE registered_user_id = v_uid;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status','already_attributed','registration_id',v_existing);
  END IF;

  -- Only treat as sub-agent if the user has the 'agent' role
  v_is_sub := public.has_role(v_uid,'agent');

  INSERT INTO public.recruitment_campaign_registrations(
    campaign_link_id, campaign_id, agent_id, registered_user_id,
    location_id, selected_source, is_sub_agent,
    qualification_status
  ) VALUES (
    v_link.id, v_link.campaign_id, v_link.agent_id, v_uid,
    v_link.location_id, v_link.selected_source, v_is_sub,
    CASE WHEN v_is_sub THEN 'active' ELSE 'registered' END
  );

  UPDATE public.recruitment_campaign_links
     SET total_registrations = total_registrations + 1,
         total_sub_agent_registrations = total_sub_agent_registrations + CASE WHEN v_is_sub THEN 1 ELSE 0 END
   WHERE id = v_link.id;

  IF p_visitor_id IS NOT NULL THEN
    UPDATE public.recruitment_campaign_clicks
       SET converted_to_registration = true
     WHERE campaign_link_id = v_link.id AND visitor_id = p_visitor_id;
  END IF;

  -- Try to set profiles.referrer_id if empty
  BEGIN
    UPDATE public.profiles SET referrer_id = v_link.agent_id
     WHERE id = v_uid AND referrer_id IS NULL;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('status','ok','link_id',v_link.id,'agent_id',v_link.agent_id,'is_sub_agent',v_is_sub);
END $$;
GRANT EXECUTE ON FUNCTION public.attach_campaign_registration(text,text) TO authenticated;

-- ==========================================================================
-- Existing 10,000 reward for 3rd verified house — extend event bonus
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(
  p_agent_id UUID,
  p_event_type TEXT,
  p_tenant_id UUID,
  p_source_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_amount NUMERIC;
  v_description TEXT;
  v_txn_group UUID := gen_random_uuid();
  v_now TIMESTAMPTZ := now();
BEGIN
  v_amount := CASE p_event_type
    WHEN 'rent_request_posted'    THEN 5000
    WHEN 'house_listed'           THEN 5000
    WHEN 'tenant_replacement'     THEN 20000
    WHEN 'subagent_registration'  THEN 10000
    WHEN 'service_centre_setup'   THEN 25000
    WHEN 'three_verified_houses'  THEN 10000
    ELSE NULL
  END;

  IF v_amount IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Unknown event_type: ' || p_event_type);
  END IF;

  v_description := CASE p_event_type
    WHEN 'rent_request_posted'    THEN 'Bonus: Rent request posted'
    WHEN 'house_listed'           THEN 'Bonus: Empty house listed'
    WHEN 'tenant_replacement'     THEN 'Bonus: Tenant replacement'
    WHEN 'subagent_registration'  THEN 'Bonus: Sub-agent registration'
    WHEN 'service_centre_setup'   THEN 'Bonus: Service Centre setup'
    WHEN 'three_verified_houses'  THEN 'Bonus: Sub-agent listed 3 verified houses'
  END;

  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commission_accrual_ledger
    WHERE source_id = p_source_id AND agent_id = p_agent_id AND event_type = p_event_type
  ) THEN
    RETURN jsonb_build_object('status', 'already_credited');
  END IF;

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, v_amount, 'cash_out', 'marketing_expense', 'commission_engine', COALESCE(p_source_id::UUID, gen_random_uuid()),
    'Marketing expense: ' || v_description, 'platform', v_txn_group);

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, v_amount, 'cash_in', 'agent_commission', 'commission_engine', COALESCE(p_source_id::UUID, gen_random_uuid()),
    v_description, 'wallet', v_txn_group);

  INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, status, description, approved_at, paid_at)
  VALUES (p_agent_id, p_tenant_id, v_amount, NULL, p_event_type, 'event_bonus', p_event_type, p_source_id, 'paid', v_description, v_now, v_now);

  RETURN jsonb_build_object('status', 'ok', 'amount', v_amount, 'event_type', p_event_type);
END;
$$;

-- Advance registration progress and pay the 3-house 10K reward once
CREATE OR REPLACE FUNCTION public.advance_campaign_house_progress(p_sub_agent_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_reg public.recruitment_campaign_registrations;
  v_new_count int;
  v_new_status public.recruitment_registration_status;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_reg FROM public.recruitment_campaign_registrations
   WHERE registered_user_id = p_sub_agent_id FOR UPDATE;
  IF v_reg.id IS NULL THEN RETURN; END IF;
  IF v_reg.verified_houses_count >= 3 THEN RETURN; END IF;

  v_new_count := v_reg.verified_houses_count + 1;
  v_new_status := CASE v_new_count
    WHEN 1 THEN 'one_verified_house'::public.recruitment_registration_status
    WHEN 2 THEN 'two_verified_houses'::public.recruitment_registration_status
    ELSE 'reward_qualified'::public.recruitment_registration_status
  END;

  UPDATE public.recruitment_campaign_registrations
     SET verified_houses_count = v_new_count,
         first_verified_house_at  = CASE WHEN v_new_count = 1 THEN v_now ELSE first_verified_house_at END,
         second_verified_house_at = CASE WHEN v_new_count = 2 THEN v_now ELSE second_verified_house_at END,
         third_verified_house_at  = CASE WHEN v_new_count = 3 THEN v_now ELSE third_verified_house_at END,
         qualification_status = v_new_status,
         reward_qualified_at  = CASE WHEN v_new_count = 3 THEN v_now ELSE reward_qualified_at END
   WHERE id = v_reg.id;

  IF v_new_count = 3 AND v_reg.reward_qualified_at IS NULL THEN
    PERFORM public.credit_agent_event_bonus(
      v_reg.agent_id,
      'three_verified_houses',
      NULL::uuid,
      'campaign_reg:' || v_reg.id::text
    );
    UPDATE public.recruitment_campaign_registrations
       SET qualification_status = 'reward_paid', reward_paid_at = v_now
     WHERE id = v_reg.id;
    UPDATE public.recruitment_campaign_links
       SET qualified_sub_agents = qualified_sub_agents + 1
     WHERE id = v_reg.campaign_link_id;
  END IF;
END $$;

-- House verification hook: fire alongside recruiter override
CREATE OR REPLACE FUNCTION public.trg_campaign_house_verified()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.verified = true AND (OLD.verified IS DISTINCT FROM true) AND NEW.agent_id IS NOT NULL THEN
    PERFORM public.advance_campaign_house_progress(NEW.agent_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_campaign_house_verified ON public.house_listings;
CREATE TRIGGER trg_campaign_house_verified
AFTER UPDATE OF verified ON public.house_listings
FOR EACH ROW EXECUTE FUNCTION public.trg_campaign_house_verified();

-- ==========================================================================
-- Aggregate RPCs (no N+1)
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_agent_campaign_dashboard()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
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
      SELECT l.*, c.name AS campaign_name, loc.display_name AS location_display
      FROM public.recruitment_campaign_links l
      JOIN public.recruitment_campaigns c ON c.id = l.campaign_id
      JOIN public.recruitment_locations loc ON loc.id = l.location_id
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
END $$;
GRANT EXECUTE ON FUNCTION public.get_agent_campaign_dashboard() TO authenticated;

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
  IF NOT (public.has_role(v_uid,'manager') OR public.has_role(v_uid,'cto') OR public.has_role(v_uid,'coo')) THEN
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
    SELECT loc.district,
           COUNT(l.*) AS links,
           COALESCE(SUM(l.total_clicks),0) AS clicks,
           COALESCE(SUM(l.unique_clicks),0) AS unique_clicks,
           COALESCE(SUM(l.total_registrations),0) AS registrations,
           COALESCE(SUM(l.total_sub_agent_registrations),0) AS sub_agents,
           COALESCE(SUM(l.qualified_sub_agents),0) AS qualified
      FROM public.recruitment_campaign_links l
      JOIN public.recruitment_locations loc ON loc.id = l.location_id
     WHERE (p_campaign_id IS NULL OR l.campaign_id = p_campaign_id)
       AND (p_from IS NULL OR l.created_at >= p_from)
       AND (p_to   IS NULL OR l.created_at <= p_to)
     GROUP BY loc.district
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
GRANT EXECUTE ON FUNCTION public.get_admin_campaign_analytics(uuid,timestamptz,timestamptz) TO authenticated;
