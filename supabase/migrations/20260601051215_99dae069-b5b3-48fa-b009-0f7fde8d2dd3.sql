CREATE TABLE public.landlord_onboarding_targets (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  landlord_id uuid NOT NULL REFERENCES public.landlords(id) ON DELETE CASCADE,
  listing_id uuid,
  status text NOT NULL DEFAULT 'targeted',
  note text,
  targeted_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (landlord_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.landlord_onboarding_targets TO authenticated;
GRANT ALL ON public.landlord_onboarding_targets TO service_role;

ALTER TABLE public.landlord_onboarding_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can view onboarding targets"
ON public.landlord_onboarding_targets
FOR SELECT
TO authenticated
USING (public.is_ops_role(auth.uid()));

CREATE POLICY "Ops can create onboarding targets"
ON public.landlord_onboarding_targets
FOR INSERT
TO authenticated
WITH CHECK (public.is_ops_role(auth.uid()));

CREATE POLICY "Ops can update onboarding targets"
ON public.landlord_onboarding_targets
FOR UPDATE
TO authenticated
USING (public.is_ops_role(auth.uid()));

CREATE POLICY "Ops can delete onboarding targets"
ON public.landlord_onboarding_targets
FOR DELETE
TO authenticated
USING (public.is_ops_role(auth.uid()));

CREATE TRIGGER update_landlord_onboarding_targets_updated_at
BEFORE UPDATE ON public.landlord_onboarding_targets
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_landlord_onboarding_targets_landlord ON public.landlord_onboarding_targets(landlord_id);