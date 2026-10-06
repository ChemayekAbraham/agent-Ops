-- Return Option elected at /funder-onboarding: 'A' = Monthly Payout, 'B' = Compounding
-- (both 15% flat). Printed on the Tenant Partnership Agreement and rebuilt from this
-- row by Partner Ops, so it must be stored rather than only used in the signup PDF.
ALTER TABLE public.partner_agreements
  ADD COLUMN IF NOT EXISTS return_option text
  CHECK (return_option IS NULL OR return_option IN ('A', 'B'));
