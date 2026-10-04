-- Audit trail for cash deposit receipt-code verification.
-- Every meaningful event (code issued, attempt, mismatch, expiry, lockout,
-- verified, credited, credit_failed) is appended here for full traceability.
CREATE TABLE public.cash_deposit_verification_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  verification_id UUID REFERENCES public.cash_deposit_verifications(id) ON DELETE CASCADE,
  deposit_request_id UUID,
  user_id UUID,
  event_type TEXT NOT NULL,
  attempt_no INTEGER,
  attempts_remaining INTEGER,
  amount NUMERIC,
  detail TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Constrain event_type to the known set for data integrity.
ALTER TABLE public.cash_deposit_verification_events
  ADD CONSTRAINT cash_deposit_verification_events_event_type_check
  CHECK (event_type IN (
    'code_issued','attempt','code_mismatch','expired','locked_out',
    'verified','credited','credit_failed','already_verified'
  ));

CREATE INDEX idx_cdve_verification_id ON public.cash_deposit_verification_events(verification_id);
CREATE INDEX idx_cdve_deposit_request_id ON public.cash_deposit_verification_events(deposit_request_id);
CREATE INDEX idx_cdve_user_id ON public.cash_deposit_verification_events(user_id);
CREATE INDEX idx_cdve_created_at ON public.cash_deposit_verification_events(created_at DESC);

-- Grants: edge functions (service_role) write; users may read their own trail.
GRANT SELECT ON public.cash_deposit_verification_events TO authenticated;
GRANT ALL ON public.cash_deposit_verification_events TO service_role;

ALTER TABLE public.cash_deposit_verification_events ENABLE ROW LEVEL SECURITY;

-- Users can view their own verification audit events. Inserts happen only via
-- the service role inside edge functions (no client insert policy).
CREATE POLICY "Users can view their own verification events"
ON public.cash_deposit_verification_events
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);