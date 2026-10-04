CREATE TABLE IF NOT EXISTS public.referral_link_deactivations (
  user_id uuid PRIMARY KEY,
  reason text NOT NULL,
  deactivated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.referral_link_deactivations TO authenticated;
GRANT ALL ON public.referral_link_deactivations TO service_role;
ALTER TABLE public.referral_link_deactivations ENABLE ROW LEVEL SECURITY;
CREATE POLICY referral_link_deactivations_owner_read ON public.referral_link_deactivations
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.trg_block_deactivated_referrer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.referrer_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.referral_link_deactivations d WHERE d.user_id = NEW.referrer_id
  ) THEN
    NEW.referrer_id := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.trg_block_deactivated_referrer() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS aa_block_deactivated_referrer ON public.profiles;
CREATE TRIGGER aa_block_deactivated_referrer
  BEFORE INSERT OR UPDATE OF referrer_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.trg_block_deactivated_referrer();

INSERT INTO public.referral_link_deactivations (user_id, reason)
VALUES ('2c6569ce-f236-464f-91b8-e04a9a0c05a6', 'Referral link deactivated on request for Timothy Kalyango')
ON CONFLICT (user_id) DO NOTHING;

DROP POLICY IF EXISTS engrep_catalog_cutovers_read ON public.engrep_catalog_cutovers;
CREATE POLICY engrep_catalog_cutovers_read ON public.engrep_catalog_cutovers
  FOR SELECT TO authenticated
  USING (engrep_is_adjudicator() OR has_role(auth.uid(), 'cto'::app_role));