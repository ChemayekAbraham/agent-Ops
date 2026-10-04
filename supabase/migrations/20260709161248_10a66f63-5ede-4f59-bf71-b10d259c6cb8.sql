CREATE TABLE public.seo_sitemap_resubmit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sitemap_hash text NOT NULL,
  url_count integer,
  changed boolean NOT NULL DEFAULT false,
  resubmitted boolean NOT NULL DEFAULT false,
  gsc_status text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.seo_sitemap_resubmit_log TO authenticated;
GRANT ALL ON public.seo_sitemap_resubmit_log TO service_role;

ALTER TABLE public.seo_sitemap_resubmit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops roles can view sitemap resubmit log"
ON public.seo_sitemap_resubmit_log
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'cto')
);

CREATE INDEX idx_seo_sitemap_resubmit_log_created_at
ON public.seo_sitemap_resubmit_log (created_at DESC);