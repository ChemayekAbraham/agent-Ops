CREATE TABLE public.profile_drafts (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  draft jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_drafts TO authenticated;
GRANT ALL ON public.profile_drafts TO service_role;

ALTER TABLE public.profile_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile draft"
ON public.profile_drafts
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own profile draft"
ON public.profile_drafts
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile draft"
ON public.profile_drafts
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own profile draft"
ON public.profile_drafts
FOR DELETE
USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_profile_drafts_updated_at
BEFORE UPDATE ON public.profile_drafts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();