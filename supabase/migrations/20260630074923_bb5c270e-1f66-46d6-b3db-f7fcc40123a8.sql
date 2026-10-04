-- 1. Source-of-truth partner agreements table
CREATE TABLE public.partner_agreements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  partner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  phone TEXT,
  email TEXT,
  national_id TEXT,
  address TEXT,
  partnership_amount NUMERIC NOT NULL DEFAULT 0,
  partnership_amount_words TEXT,
  payout_mode TEXT NOT NULL DEFAULT 'bank',
  bank_name TEXT,
  bank_account_name TEXT,
  bank_account_number TEXT,
  momo_provider TEXT,
  momo_number TEXT,
  momo_name TEXT,
  kin_name TEXT,
  kin_contact TEXT,
  reference TEXT,
  agreement_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  status TEXT NOT NULL DEFAULT 'pending',
  countersigned_by UUID REFERENCES auth.users(id),
  countersigned_at TIMESTAMPTZ,
  generated_pdf_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_agreements_partner_unique UNIQUE (partner_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_agreements TO authenticated;
GRANT ALL ON public.partner_agreements TO service_role;

ALTER TABLE public.partner_agreements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Partners can view their own agreement"
ON public.partner_agreements FOR SELECT TO authenticated
USING (auth.uid() = partner_id OR public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Partners can create their own agreement"
ON public.partner_agreements FOR INSERT TO authenticated
WITH CHECK (auth.uid() = partner_id OR public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Partners can update their own agreement"
ON public.partner_agreements FOR UPDATE TO authenticated
USING (auth.uid() = partner_id OR public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'))
WITH CHECK (auth.uid() = partner_id OR public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can delete agreements"
ON public.partner_agreements FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'manager'));

CREATE INDEX idx_partner_agreements_partner ON public.partner_agreements(partner_id);
CREATE INDEX idx_partner_agreements_status ON public.partner_agreements(status);

-- 2. Singleton company countersignature defaults
CREATE TABLE public.partner_agreement_company_defaults (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rep_name TEXT,
  rep_position TEXT,
  rep_contact TEXT,
  signature_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_agreement_company_defaults TO authenticated;
GRANT ALL ON public.partner_agreement_company_defaults TO service_role;

ALTER TABLE public.partner_agreement_company_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read company defaults"
ON public.partner_agreement_company_defaults FOR SELECT TO authenticated
USING (true);

CREATE POLICY "Managers can insert company defaults"
ON public.partner_agreement_company_defaults FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can update company defaults"
ON public.partner_agreement_company_defaults FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'manager'))
WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- seed a single empty defaults row so the renderer always has something to read
INSERT INTO public.partner_agreement_company_defaults (rep_name, rep_position, rep_contact)
VALUES (NULL, NULL, NULL);

-- 3. updated_at triggers (reuse existing helper)
CREATE TRIGGER update_partner_agreements_updated_at
BEFORE UPDATE ON public.partner_agreements
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_partner_agreement_company_defaults_updated_at
BEFORE UPDATE ON public.partner_agreement_company_defaults
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();