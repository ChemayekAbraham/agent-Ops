-- Lending Agent Loans: peer loans where a Welile agent lends from their own wallet
CREATE TABLE IF NOT EXISTS public.lending_agent_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_agent_id UUID NOT NULL,
  borrower_user_id UUID,
  borrower_ai_id TEXT NOT NULL,
  borrower_display_name TEXT,
  borrower_phone TEXT,

  principal_ugx NUMERIC(14,2) NOT NULL CHECK (principal_ugx > 0),
  interest_rate_pct NUMERIC(5,2) DEFAULT 0 CHECK (interest_rate_pct >= 0 AND interest_rate_pct <= 100),
  expected_repayment_date DATE,
  loan_purpose TEXT,
  external_loan_reference TEXT,

  -- Welile takes a 1% platform fee at disbursement (per Lending Agent Agreement)
  platform_fee_ugx NUMERIC(14,2) NOT NULL DEFAULT 0,

  -- Snapshots at disbursement
  lender_trust_score_at_record INTEGER,
  borrower_trust_score_at_record INTEGER,
  borrower_trust_tier_at_record TEXT,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','partially_repaid','repaid','defaulted','written_off','cancelled')),
  amount_repaid_ugx NUMERIC(14,2) NOT NULL DEFAULT 0,
  last_repayment_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lending_agent_loans_lender ON public.lending_agent_loans(lender_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_lending_agent_loans_borrower ON public.lending_agent_loans(borrower_user_id) WHERE borrower_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lending_agent_loans_ai_id ON public.lending_agent_loans(borrower_ai_id);
CREATE INDEX IF NOT EXISTS idx_lending_agent_loans_status ON public.lending_agent_loans(status);

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_lending_agent_loans_updated_at ON public.lending_agent_loans;
CREATE TRIGGER trg_lending_agent_loans_updated_at
BEFORE UPDATE ON public.lending_agent_loans
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.lending_agent_loans ENABLE ROW LEVEL SECURITY;

-- Lender agent can view their own loans
CREATE POLICY "Lender agent sees own loans"
ON public.lending_agent_loans
FOR SELECT
TO authenticated
USING (lender_agent_id = auth.uid());

-- Borrower can view loans against them
CREATE POLICY "Borrower sees loans against them"
ON public.lending_agent_loans
FOR SELECT
TO authenticated
USING (borrower_user_id = auth.uid());

-- Managers see everything
CREATE POLICY "Managers see all lending agent loans"
ON public.lending_agent_loans
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'manager'));

-- Lender agent can insert their own loans (gated by signed agreement check at app layer)
CREATE POLICY "Lender agent creates own loans"
ON public.lending_agent_loans
FOR INSERT
TO authenticated
WITH CHECK (
  lender_agent_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.lending_agent_agreement_acceptance laa
    WHERE laa.agent_user_id = auth.uid() AND laa.status = 'accepted'
  )
);

-- Lender agent can update their own loans (record repayments, mark status)
CREATE POLICY "Lender agent updates own loans"
ON public.lending_agent_loans
FOR UPDATE
TO authenticated
USING (lender_agent_id = auth.uid())
WITH CHECK (lender_agent_id = auth.uid());

-- Managers can update any loan
CREATE POLICY "Managers update any lending agent loan"
ON public.lending_agent_loans
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'manager'))
WITH CHECK (public.has_role(auth.uid(), 'manager'));