CREATE TABLE public.merchandise_share_opens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  catalog_id uuid,
  item_name text,
  is_bot boolean NOT NULL DEFAULT false,
  user_agent text,
  referrer text,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_merch_share_opens_created ON public.merchandise_share_opens (created_at DESC);
CREATE INDEX idx_merch_share_opens_catalog ON public.merchandise_share_opens (catalog_id);

GRANT SELECT ON public.merchandise_share_opens TO authenticated;
GRANT ALL ON public.merchandise_share_opens TO service_role;

ALTER TABLE public.merchandise_share_opens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leadership can view merchandise share opens"
ON public.merchandise_share_opens
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cmo') OR
  public.has_role(auth.uid(), 'cfo') OR
  public.has_role(auth.uid(), 'manager') OR
  public.has_role(auth.uid(), 'super_admin')
);