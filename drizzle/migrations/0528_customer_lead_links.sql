CREATE TABLE public.lead_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL UNIQUE CHECK (kind IN ('partnership','tenant')),
  short_code text NOT NULL UNIQUE CHECK (short_code ~ '^[A-Za-z0-9_-]{3,32}$'),
  destination_path text NOT NULL,
  referrer_label text NOT NULL DEFAULT 'NeexaBot',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.lead_links TO authenticated;
GRANT ALL ON public.lead_links TO service_role;
ALTER TABLE public.lead_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CRM can read lead links" ON public.lead_links FOR SELECT TO authenticated
USING (has_role(auth.uid(),'crm') OR has_role(auth.uid(),'cto') OR has_role(auth.uid(),'super_admin'));

CREATE TABLE public.lead_link_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.lead_links(id),
  ip_address text, user_agent text, device_class text, device_model text,
  os text, os_version text, browser text, browser_version text,
  is_bot boolean NOT NULL DEFAULT false,
  country text, city text, region text, referrer text, visitor_hash text,
  user_id uuid, came_in_at timestamptz, is_new_registration boolean,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_link_clicks_link_created ON public.lead_link_clicks(link_id, created_at DESC);
GRANT SELECT ON public.lead_link_clicks TO authenticated;
GRANT ALL ON public.lead_link_clicks TO service_role;
ALTER TABLE public.lead_link_clicks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CRM can read lead clicks" ON public.lead_link_clicks FOR SELECT TO authenticated
USING (has_role(auth.uid(),'crm') OR has_role(auth.uid(),'cto') OR has_role(auth.uid(),'super_admin'));

-- Links a click to the signed-in visitor once, within 30 days of the click.
CREATE OR REPLACE FUNCTION public.claim_lead_click(p_click_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_created timestamptz; n int;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  SELECT created_at INTO v_created FROM profiles WHERE id = v_uid;
  UPDATE lead_link_clicks c SET user_id = v_uid, came_in_at = now(),
    is_new_registration = (v_created IS NOT NULL AND v_created >= c.created_at - interval '5 minutes')
  WHERE c.id = p_click_id AND c.user_id IS NULL AND c.created_at > now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;
REVOKE ALL ON FUNCTION public.claim_lead_click(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_lead_click(uuid) TO authenticated;

INSERT INTO public.lead_links(kind, short_code, destination_path) VALUES
 ('partnership','partner','/funder-onboarding'),
 ('tenant','tenants','/tenants-onboarding');