CREATE TABLE public.angel_pool_email_skips (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  investor_id uuid,
  reference_id text,
  recipient_email text,
  reason text NOT NULL,
  funding_source text,
  source_function text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.angel_pool_email_skips TO authenticated;
GRANT ALL ON public.angel_pool_email_skips TO service_role;

ALTER TABLE public.angel_pool_email_skips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Executives can view angel pool email skips"
ON public.angel_pool_email_skips
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'manager')
);

CREATE INDEX idx_angel_pool_email_skips_created ON public.angel_pool_email_skips (created_at DESC);
CREATE INDEX idx_angel_pool_email_skips_reason ON public.angel_pool_email_skips (reason);