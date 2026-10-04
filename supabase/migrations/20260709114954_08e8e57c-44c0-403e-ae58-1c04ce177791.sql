-- UTM attribution for careers link: track where sign-ups come from
ALTER TABLE public.job_applications
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS utm_medium text,
  ADD COLUMN IF NOT EXISTS utm_campaign text;

-- Anonymous click log for the careers link, one row per landing with UTM tags
CREATE TABLE IF NOT EXISTS public.career_link_clicks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  landing_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_career_link_clicks_source ON public.career_link_clicks (utm_source);
CREATE INDEX IF NOT EXISTS idx_career_link_clicks_created ON public.career_link_clicks (created_at DESC);

GRANT INSERT ON public.career_link_clicks TO anon, authenticated;
GRANT SELECT ON public.career_link_clicks TO authenticated;
GRANT ALL ON public.career_link_clicks TO service_role;

ALTER TABLE public.career_link_clicks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can log a careers link click"
  ON public.career_link_clicks FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Staff can view careers link clicks"
  ON public.career_link_clicks FOR SELECT
  USING (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'hr'::app_role)
    OR has_role(auth.uid(), 'cto'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
  );