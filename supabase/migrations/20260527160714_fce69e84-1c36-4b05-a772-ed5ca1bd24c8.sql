CREATE TABLE public.email_credit_manual_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_transaction_id uuid NOT NULL,
  gmail_message_id text,
  email_tid text,
  mark text NOT NULL CHECK (mark IN ('credited','uncredited')),
  reason text,
  marked_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_credit_manual_marks_tx_idx
  ON public.email_credit_manual_marks (gmail_transaction_id, created_at DESC);
CREATE INDEX email_credit_manual_marks_created_idx
  ON public.email_credit_manual_marks (created_at DESC);

GRANT SELECT, INSERT ON public.email_credit_manual_marks TO authenticated;
GRANT ALL ON public.email_credit_manual_marks TO service_role;

ALTER TABLE public.email_credit_manual_marks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Financial Ops can read email credit marks"
ON public.email_credit_manual_marks
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cto'::app_role)
);

CREATE POLICY "Financial Ops can insert email credit marks"
ON public.email_credit_manual_marks
FOR INSERT
TO authenticated
WITH CHECK (
  marked_by = auth.uid()
  AND (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'cto'::app_role)
  )
);