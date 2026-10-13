CREATE TABLE public.tenant_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  short_code text NOT NULL UNIQUE,
  destination_url text NOT NULL,
  message_template text NOT NULL,
  fallback_template text NOT NULL,
  test_phones text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.tenant_campaign_waves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.tenant_campaigns(id),
  wave_no int NOT NULL,
  segment text NOT NULL CHECK (segment IN ('repaying','completed','funded')),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','sent','paused','stopped')),
  started_at timestamptz,
  finished_at timestamptz,
  note text,
  UNIQUE (campaign_id, wave_no)
);
CREATE TABLE public.tenant_campaign_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.tenant_campaigns(id),
  wave_id uuid REFERENCES public.tenant_campaign_waves(id),
  tenant_id uuid,
  recipient_name text,
  phone text NOT NULL,
  segment text,
  rent_amount numeric,
  is_test boolean NOT NULL DEFAULT false,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenant_campaign_sends_once ON public.tenant_campaign_sends (campaign_id, tenant_id) WHERE NOT is_test AND tenant_id IS NOT NULL;
CREATE INDEX tenant_campaign_sends_wave ON public.tenant_campaign_sends (wave_id, status);
CREATE TABLE public.tenant_campaign_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.tenant_campaigns(id),
  clicked_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  device_class text,
  os text,
  browser text,
  is_bot boolean NOT NULL DEFAULT false,
  visitor_hash text,
  referrer text,
  gps_status text,
  gps_lat double precision,
  gps_lng double precision,
  gps_accuracy double precision,
  country text,
  city text
);
CREATE INDEX tenant_campaign_clicks_c ON public.tenant_campaign_clicks (campaign_id, clicked_at DESC);

GRANT SELECT ON public.tenant_campaigns, public.tenant_campaign_waves, public.tenant_campaign_sends, public.tenant_campaign_clicks TO authenticated;
GRANT ALL ON public.tenant_campaigns, public.tenant_campaign_waves, public.tenant_campaign_sends, public.tenant_campaign_clicks TO service_role;
ALTER TABLE public.tenant_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_campaign_waves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_campaign_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_campaign_clicks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read campaigns" ON public.tenant_campaigns FOR SELECT TO authenticated USING (public._has_enabled_role(auth.uid(), ARRAY['crm','cto','super_admin','ceo','coo','cmo','manager']));
CREATE POLICY "staff read waves" ON public.tenant_campaign_waves FOR SELECT TO authenticated USING (public._has_enabled_role(auth.uid(), ARRAY['crm','cto','super_admin','ceo','coo','cmo','manager']));
CREATE POLICY "staff read sends" ON public.tenant_campaign_sends FOR SELECT TO authenticated USING (public._has_enabled_role(auth.uid(), ARRAY['crm','cto','super_admin','ceo','coo','cmo','manager']));
CREATE POLICY "staff read clicks" ON public.tenant_campaign_clicks FOR SELECT TO authenticated USING (public._has_enabled_role(auth.uid(), ARRAY['crm','cto','super_admin','ceo','coo','cmo','manager']));

-- Who the campaign targets: one row per tenant, under their highest-priority Rent Plan status.
CREATE OR REPLACE FUNCTION public.tenant_campaign_audience()
RETURNS TABLE (tenant_id uuid, full_name text, phone text, segment text, rent_amount numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH ranked AS (
    SELECT DISTINCT ON (r.tenant_id) r.tenant_id, r.status, r.rent_amount
    FROM rent_requests r
    WHERE r.tenant_id IS NOT NULL AND r.status IN ('repaying','completed','funded')
    ORDER BY r.tenant_id, CASE r.status WHEN 'repaying' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, r.created_at DESC
  )
  SELECT k.tenant_id, p.full_name, p.phone, k.status, k.rent_amount
  FROM ranked k JOIN profiles p ON p.id = k.tenant_id
  WHERE length(regexp_replace(coalesce(p.phone,''), '[^0-9]', '', 'g')) >= 9
$$;
REVOKE ALL ON FUNCTION public.tenant_campaign_audience() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_campaign_audience() TO service_role;

-- CRM overview of one campaign.
CREATE OR REPLACE FUNCTION public.crm_tenant_campaign_overview(p_slug text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE c tenant_campaigns; out jsonb;
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['crm','cto','super_admin','ceo','coo','cmo','manager']) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  SELECT * INTO c FROM tenant_campaigns WHERE slug = p_slug;
  IF c.id IS NULL THEN RETURN NULL; END IF;
  WITH aud AS (SELECT * FROM public.tenant_campaign_audience()),
  real_clicks AS (SELECT * FROM tenant_campaign_clicks WHERE campaign_id = c.id AND NOT is_bot)
  SELECT jsonb_build_object(
    'campaign', to_jsonb(c),
    'audience', jsonb_build_object(
      'total', (SELECT count(*) FROM aud),
      'repaying', (SELECT count(*) FROM aud WHERE segment='repaying'),
      'completed', (SELECT count(*) FROM aud WHERE segment='completed'),
      'funded', (SELECT count(*) FROM aud WHERE segment='funded'),
      'with_rent', (SELECT count(*) FROM aud WHERE rent_amount > 0)),
    'waves', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', w.id, 'wave_no', w.wave_no, 'segment', w.segment, 'scheduled_at', w.scheduled_at,
        'status', w.status, 'started_at', w.started_at, 'finished_at', w.finished_at, 'note', w.note,
        'audience', (SELECT count(*) FROM aud a WHERE a.segment = w.segment),
        'sent', (SELECT count(*) FROM tenant_campaign_sends s WHERE s.wave_id=w.id AND s.status='sent'),
        'failed', (SELECT count(*) FROM tenant_campaign_sends s WHERE s.wave_id=w.id AND s.status='failed'),
        'skipped', (SELECT count(*) FROM tenant_campaign_sends s WHERE s.wave_id=w.id AND s.status='skipped')
      ) ORDER BY w.wave_no) FROM tenant_campaign_waves w WHERE w.campaign_id=c.id), '[]'::jsonb),
    'tests', coalesce((SELECT jsonb_agg(jsonb_build_object('phone', s.phone, 'status', s.status, 'error', s.error, 'sent_at', coalesce(s.sent_at, s.created_at), 'message', s.message) ORDER BY s.created_at DESC)
        FROM (SELECT * FROM tenant_campaign_sends WHERE campaign_id=c.id AND is_test ORDER BY created_at DESC LIMIT 10) s), '[]'::jsonb),
    'clicks', jsonb_build_object(
      'total', (SELECT count(*) FROM real_clicks),
      'unique_est', (SELECT count(DISTINCT visitor_hash) FROM real_clicks),
      'bots', (SELECT count(*) FROM tenant_campaign_clicks WHERE campaign_id=c.id AND is_bot),
      'with_gps', (SELECT count(*) FROM real_clicks WHERE gps_lat IS NOT NULL),
      'by_device', coalesce((SELECT jsonb_agg(x) FROM (SELECT coalesce(device_class,'unknown') label, count(*) n FROM real_clicks GROUP BY 1 ORDER BY 2 DESC LIMIT 8) x), '[]'::jsonb),
      'by_os', coalesce((SELECT jsonb_agg(x) FROM (SELECT coalesce(os,'unknown') label, count(*) n FROM real_clicks GROUP BY 1 ORDER BY 2 DESC LIMIT 8) x), '[]'::jsonb),
      'by_browser', coalesce((SELECT jsonb_agg(x) FROM (SELECT coalesce(browser,'unknown') label, count(*) n FROM real_clicks GROUP BY 1 ORDER BY 2 DESC LIMIT 8) x), '[]'::jsonb),
      'by_hour', coalesce((SELECT jsonb_agg(x ORDER BY x.h) FROM (SELECT date_trunc('hour', clicked_at) h, count(*) n FROM real_clicks GROUP BY 1) x), '[]'::jsonb),
      'recent', coalesce((SELECT jsonb_agg(x) FROM (SELECT clicked_at, device_class, os, browser, ip_address, city, country, gps_status, gps_lat, gps_lng, gps_accuracy, user_agent FROM real_clicks ORDER BY clicked_at DESC LIMIT 50) x), '[]'::jsonb))
  ) INTO out;
  RETURN out;
END $$;
REVOKE ALL ON FUNCTION public.crm_tenant_campaign_overview(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_tenant_campaign_overview(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.crm_tenant_campaign_set_wave(p_wave_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['crm','cto','super_admin']) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_status NOT IN ('paused','scheduled') THEN RAISE EXCEPTION 'Only pause or resume'; END IF;
  UPDATE tenant_campaign_waves SET status = p_status,
    note = CASE WHEN p_status='paused' THEN 'Paused from CRM' ELSE 'Resumed from CRM' END
  WHERE id = p_wave_id AND status IN ('scheduled','paused','sending','stopped');
  INSERT INTO system_events (event_type, actor_id, metadata)
  VALUES ('tenant_campaign.wave_status_changed', auth.uid(), jsonb_build_object('wave_id', p_wave_id, 'status', p_status));
END $$;
REVOKE ALL ON FUNCTION public.crm_tenant_campaign_set_wave(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_tenant_campaign_set_wave(uuid, text) TO authenticated;

-- Lets the sender switch its own schedule off after the last wave.
CREATE OR REPLACE FUNCTION public.tenant_campaign_unschedule(p_job_names text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, cron AS $$
DECLARE j text;
BEGIN
  FOREACH j IN ARRAY p_job_names LOOP
    IF j LIKE 'tenant-campaign-%' AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
      PERFORM cron.unschedule(j);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.tenant_campaign_unschedule(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_campaign_unschedule(text[]) TO service_role;