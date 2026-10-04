
CREATE TABLE public.wallet_debit_bucket_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL,
  target_user_name text,
  attempted_bucket text NOT NULL CHECK (attempted_bucket IN ('withdrawable','float','proxy_withdrawable')),
  amount numeric NOT NULL CHECK (amount > 0),
  available_at_attempt numeric NOT NULL DEFAULT 0,
  outcome text NOT NULL CHECK (outcome IN ('insufficient_funds_blocked','switched','succeeded','failed_other')),
  switched_to_bucket text CHECK (switched_to_bucket IN ('withdrawable','float','proxy_withdrawable')),
  failure_reason text,
  gmail_transaction_id uuid,
  transaction_reference text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wdba_target_user_created_at ON public.wallet_debit_bucket_attempts (target_user_id, created_at DESC);
CREATE INDEX idx_wdba_gmail_tx ON public.wallet_debit_bucket_attempts (gmail_transaction_id) WHERE gmail_transaction_id IS NOT NULL;

GRANT SELECT, INSERT ON public.wallet_debit_bucket_attempts TO authenticated;
GRANT ALL ON public.wallet_debit_bucket_attempts TO service_role;

ALTER TABLE public.wallet_debit_bucket_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can read all debit bucket attempts"
ON public.wallet_debit_bucket_attempts
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE POLICY "Authenticated can log own debit attempts"
ON public.wallet_debit_bucket_attempts
FOR INSERT
TO authenticated
WITH CHECK (created_by = auth.uid());
