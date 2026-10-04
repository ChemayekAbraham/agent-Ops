CREATE TABLE IF NOT EXISTS public.seo_index_monitor_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  site_url text NOT NULL,
  sitemap_submitted_count integer,
  sitemap_indexed_count integer,
  sitemap_errors integer,
  sitemap_warnings integer,
  url_verdict text,
  coverage_state text,
  indexing_state text,
  robots_state text,
  google_canonical text,
  pages_indexed boolean NOT NULL DEFAULT false,
  has_errors boolean NOT NULL DEFAULT false,
  alert_type text,
  alert_sent boolean NOT NULL DEFAULT false,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_monitor_snapshots_checked_at
  ON public.seo_index_monitor_snapshots (checked_at DESC);

GRANT SELECT ON public.seo_index_monitor_snapshots TO authenticated;
GRANT ALL ON public.seo_index_monitor_snapshots TO service_role;

ALTER TABLE public.seo_index_monitor_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ops can view SEO monitor snapshots" ON public.seo_index_monitor_snapshots;
CREATE POLICY "Ops can view SEO monitor snapshots"
  ON public.seo_index_monitor_snapshots
  FOR SELECT TO authenticated
  USING (public.is_ops_role(auth.uid()));

CREATE TABLE IF NOT EXISTS public.seo_index_monitor_settings (
  id boolean PRIMARY KEY DEFAULT true,
  alert_email text NOT NULL DEFAULT 'weliletenants@gmail.com',
  alerts_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seo_monitor_settings_singleton CHECK (id = true)
);

INSERT INTO public.seo_index_monitor_settings (id) VALUES (true)
  ON CONFLICT (id) DO NOTHING;

GRANT SELECT, UPDATE ON public.seo_index_monitor_settings TO authenticated;
GRANT ALL ON public.seo_index_monitor_settings TO service_role;

ALTER TABLE public.seo_index_monitor_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ops can view SEO monitor settings" ON public.seo_index_monitor_settings;
CREATE POLICY "Ops can view SEO monitor settings"
  ON public.seo_index_monitor_settings
  FOR SELECT TO authenticated
  USING (public.is_ops_role(auth.uid()));

DROP POLICY IF EXISTS "Ops can update SEO monitor settings" ON public.seo_index_monitor_settings;
CREATE POLICY "Ops can update SEO monitor settings"
  ON public.seo_index_monitor_settings
  FOR UPDATE TO authenticated
  USING (public.is_ops_role(auth.uid()))
  WITH CHECK (public.is_ops_role(auth.uid()));