-- Cash deposit receipt-code verification
-- Stores a HASH of the auto-generated receipt code that is emailed to the
-- cash verifier (weliletenants@gmail.com). The depositor enters the code
-- read back to them; the verify edge function hashes the input and compares.
-- Service-role only: end users never read this table directly (the plaintext
-- code lives only in the verifier's inbox), so no anon/authenticated grants.
CREATE TABLE public.cash_deposit_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_request_id uuid NOT NULL REFERENCES public.deposit_requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  amount numeric NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  status text NOT NULL DEFAULT 'awaiting_code', -- awaiting_code | verified | expired
  emailed_to text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Only edge functions (service_role bypasses RLS) touch this table.
GRANT ALL ON public.cash_deposit_verifications TO service_role;

ALTER TABLE public.cash_deposit_verifications ENABLE ROW LEVEL SECURITY;

-- Intentionally NO policies for anon/authenticated: the hashed code and
-- verification state must never be readable client-side.

CREATE INDEX idx_cash_deposit_verifications_deposit
  ON public.cash_deposit_verifications(deposit_request_id);
CREATE INDEX idx_cash_deposit_verifications_user_status
  ON public.cash_deposit_verifications(user_id, status);