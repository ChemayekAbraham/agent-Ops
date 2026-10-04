CREATE TABLE public.semrush_brand_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  captured_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'manual',
  domain TEXT NOT NULL DEFAULT 'welileapp.com',
  brand_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  domain_summary JSONB,
  backlinks_summary JSONB,
  raw JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT ON public.semrush_brand_snapshots TO authenticated;
GRANT ALL ON public.semrush_brand_snapshots TO service_role;

ALTER TABLE public.semrush_brand_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated staff can view brand snapshots"
ON public.semrush_brand_snapshots
FOR SELECT
TO authenticated
USING (true);

CREATE INDEX idx_semrush_brand_snapshots_captured_at
ON public.semrush_brand_snapshots (captured_at DESC);