CREATE TABLE public.smartphone_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand text NOT NULL,
  model_name text NOT NULL,
  default_amount numeric NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX smartphone_catalog_brand_model_key
  ON public.smartphone_catalog (lower(brand), lower(model_name));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.smartphone_catalog TO authenticated;
GRANT ALL ON public.smartphone_catalog TO service_role;

ALTER TABLE public.smartphone_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view active catalog"
ON public.smartphone_catalog
FOR SELECT
TO authenticated
USING (is_active = true OR public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Ops can manage catalog"
ON public.smartphone_catalog
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'))
WITH CHECK (public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'));

CREATE TRIGGER update_smartphone_catalog_updated_at
BEFORE UPDATE ON public.smartphone_catalog
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();