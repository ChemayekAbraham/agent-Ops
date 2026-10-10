ALTER TABLE public.lending_agent_loans
  ADD COLUMN IF NOT EXISTS funding_source text NOT NULL DEFAULT 'withdrawable',
  ADD COLUMN IF NOT EXISTS disbursement_reference text,
  ADD COLUMN IF NOT EXISTS principal_repaid_ugx numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interest_repaid_ugx numeric NOT NULL DEFAULT 0;
ALTER TABLE public.lending_agent_loans
  ADD CONSTRAINT lending_agent_loans_funding_source_ck CHECK (funding_source IN ('withdrawable','float'));
CREATE UNIQUE INDEX IF NOT EXISTS lending_agent_loans_disb_ref_uq ON public.lending_agent_loans(disbursement_reference) WHERE disbursement_reference IS NOT NULL;
COMMENT ON COLUMN public.lending_agent_loans.funding_source IS 'float = principal lent from lender operational float into borrower float; repayments split principal->lender float, interest->lender withdrawable';