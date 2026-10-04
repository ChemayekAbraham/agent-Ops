CREATE TABLE public.email_payout_match_attempts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  operator_id UUID,
  withdrawal_id UUID,
  email_id UUID,
  email_transaction_id TEXT,
  withdrawal_amount NUMERIC,
  email_amount NUMERIC,
  amount_delta NUMERIC,
  recipient_phone_target TEXT,
  recipient_phone_email TEXT,
  payment_method TEXT,
  outcome TEXT NOT NULL,
  error_message TEXT,
  tolerance_amount_ugx INTEGER,
  tolerance_phone_tail INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT email_payout_match_attempts_outcome_chk CHECK (
    outcome IN (
      'matched_auto_approved',
      'matched_approve_failed',
      'matched_manual_retry_ok',
      'matched_manual_retry_failed',
      'tid_burned_skip',
      'no_match'
    )
  )
);

CREATE INDEX idx_empa_attempted_at  ON public.email_payout_match_attempts (attempted_at DESC);
CREATE INDEX idx_empa_withdrawal_id ON public.email_payout_match_attempts (withdrawal_id);
CREATE INDEX idx_empa_email_tid     ON public.email_payout_match_attempts (email_transaction_id);
CREATE INDEX idx_empa_outcome       ON public.email_payout_match_attempts (outcome);

GRANT SELECT, INSERT ON public.email_payout_match_attempts TO authenticated;
GRANT ALL ON public.email_payout_match_attempts TO service_role;

ALTER TABLE public.email_payout_match_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "FinOps leadership can view match attempts"
ON public.email_payout_match_attempts
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
);

CREATE POLICY "Operators insert their own match attempts"
ON public.email_payout_match_attempts
FOR INSERT
TO authenticated
WITH CHECK (operator_id IS NULL OR operator_id = auth.uid());
