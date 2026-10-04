CREATE TABLE public.email_credit_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_transaction_id uuid,
  gmail_message_id text,
  email_tid text,
  target_user_id uuid NOT NULL,
  amount numeric NOT NULL,
  operation text NOT NULL DEFAULT 'credit',
  reference_id text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One credit per (email message, recipient)
CREATE UNIQUE INDEX email_credit_idem_msg_user_uniq
  ON public.email_credit_idempotency (gmail_message_id, target_user_id)
  WHERE gmail_message_id IS NOT NULL;

-- One credit per (telecom TID, recipient) — guards against the same payout
-- email being re-imported with a different gmail_message_id
CREATE UNIQUE INDEX email_credit_idem_tid_user_uniq
  ON public.email_credit_idempotency (email_tid, target_user_id)
  WHERE email_tid IS NOT NULL;

CREATE INDEX email_credit_idem_created_at_idx
  ON public.email_credit_idempotency (created_at DESC);

GRANT SELECT ON public.email_credit_idempotency TO authenticated;
GRANT ALL ON public.email_credit_idempotency TO service_role;

ALTER TABLE public.email_credit_idempotency ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Financial Ops can read email credit idempotency"
ON public.email_credit_idempotency
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cto'::app_role)
);