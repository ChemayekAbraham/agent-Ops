
-- ===== 1. Lender Partners =====
CREATE TABLE public.lender_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  legal_name TEXT NOT NULL,
  partner_type TEXT NOT NULL DEFAULT 'individual', -- individual | mfi | bank | sacco | other
  contact_phone TEXT NOT NULL,
  contact_email TEXT,
  registration_number TEXT,
  kyc_status TEXT NOT NULL DEFAULT 'pending', -- pending | verified | rejected
  agreement_accepted BOOLEAN NOT NULL DEFAULT false,
  agreement_version TEXT,
  agreement_accepted_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.lender_partners ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lenders manage own partner record"
  ON public.lender_partners FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Staff view all lender partners"
  ON public.lender_partners FOR SELECT
  USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Staff update lender partners"
  ON public.lender_partners FOR UPDATE
  USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

-- ===== 2. Vouch Claims (recorded loans) =====
CREATE TABLE public.vouch_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_partner_id UUID NOT NULL REFERENCES public.lender_partners(id) ON DELETE RESTRICT,
  borrower_user_id UUID NOT NULL,
  borrower_ai_id TEXT NOT NULL,
  principal_ugx NUMERIC(14,2) NOT NULL CHECK (principal_ugx > 0),
  vouched_amount_ugx NUMERIC(14,2) NOT NULL,
  trust_score_at_record INTEGER,
  trust_tier_at_record TEXT,
  loan_purpose TEXT,
  disbursement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_repayment_date DATE,
  interest_rate_pct NUMERIC(5,2),
  external_loan_reference TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | repaid | defaulted | claim_paid | disputed
  default_reported_at TIMESTAMPTZ,
  claim_paid_at TIMESTAMPTZ,
  claim_paid_amount_ugx NUMERIC(14,2),
  recovery_status TEXT DEFAULT 'none', -- none | recovering | fully_recovered
  recovered_amount_ugx NUMERIC(14,2) DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_vouch_claims_borrower ON public.vouch_claims(borrower_user_id);
CREATE INDEX idx_vouch_claims_lender ON public.vouch_claims(lender_partner_id);
CREATE INDEX idx_vouch_claims_status ON public.vouch_claims(status);

ALTER TABLE public.vouch_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Borrower views own vouch claims"
  ON public.vouch_claims FOR SELECT
  USING (auth.uid() = borrower_user_id);

CREATE POLICY "Lender views own vouch claims"
  ON public.vouch_claims FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.lender_partners lp
    WHERE lp.id = vouch_claims.lender_partner_id AND lp.user_id = auth.uid()
  ));

CREATE POLICY "Lender records vouch claims"
  ON public.vouch_claims FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.lender_partners lp
    WHERE lp.id = vouch_claims.lender_partner_id
      AND lp.user_id = auth.uid()
      AND lp.agreement_accepted = true
      AND lp.is_active = true
  ));

CREATE POLICY "Lender updates own vouch claims"
  ON public.vouch_claims FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.lender_partners lp
    WHERE lp.id = vouch_claims.lender_partner_id AND lp.user_id = auth.uid()
  ));

CREATE POLICY "Staff view all vouch claims"
  ON public.vouch_claims FOR SELECT
  USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cfo'));

CREATE POLICY "Staff update vouch claims"
  ON public.vouch_claims FOR UPDATE
  USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cfo'));

-- ===== 3. Borrower Vouch Disclosure Acknowledgements =====
CREATE TABLE public.borrower_vouch_disclosures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  disclosure_version TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ai_id TEXT,
  vouched_limit_at_acknowledgement NUMERIC(14,2),
  ip_address TEXT,
  device_info TEXT
);

CREATE INDEX idx_borrower_vouch_disclosures_user ON public.borrower_vouch_disclosures(user_id);

ALTER TABLE public.borrower_vouch_disclosures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own vouch disclosures"
  ON public.borrower_vouch_disclosures FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Staff view all vouch disclosures"
  ON public.borrower_vouch_disclosures FOR SELECT
  USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

-- ===== 4. Lender Vouch Agreement Acceptance =====
CREATE TABLE public.lender_vouch_agreement_acceptance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_user_id UUID NOT NULL,
  agreement_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT,
  device_info TEXT,
  status TEXT NOT NULL DEFAULT 'accepted'
);

CREATE INDEX idx_lender_agreement_user ON public.lender_vouch_agreement_acceptance(lender_user_id);

ALTER TABLE public.lender_vouch_agreement_acceptance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lenders manage own agreement"
  ON public.lender_vouch_agreement_acceptance FOR ALL
  USING (auth.uid() = lender_user_id) WITH CHECK (auth.uid() = lender_user_id);

CREATE POLICY "Staff view lender agreements"
  ON public.lender_vouch_agreement_acceptance FOR SELECT
  USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

-- ===== 5. Lending Agent Agreement Acceptance =====
CREATE TABLE public.lending_agent_agreement_acceptance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id UUID NOT NULL,
  agreement_version TEXT NOT NULL,
  trust_score_at_acceptance INTEGER,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT,
  device_info TEXT,
  status TEXT NOT NULL DEFAULT 'accepted'
);

CREATE INDEX idx_lending_agent_agreement_user ON public.lending_agent_agreement_acceptance(agent_user_id);

ALTER TABLE public.lending_agent_agreement_acceptance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents manage own lending agreement"
  ON public.lending_agent_agreement_acceptance FOR ALL
  USING (auth.uid() = agent_user_id) WITH CHECK (auth.uid() = agent_user_id);

CREATE POLICY "Staff view lending agent agreements"
  ON public.lending_agent_agreement_acceptance FOR SELECT
  USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

-- ===== 6. updated_at triggers =====
CREATE TRIGGER trg_lender_partners_updated_at
  BEFORE UPDATE ON public.lender_partners
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_vouch_claims_updated_at
  BEFORE UPDATE ON public.vouch_claims
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
