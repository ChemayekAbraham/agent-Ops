CREATE TABLE IF NOT EXISTS public.email_routing_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_transaction_id uuid REFERENCES public.gmail_transactions(id) ON DELETE SET NULL,
  gmail_message_id text,
  transaction_id text,
  from_email text,
  from_name text,
  subject text,
  amount numeric NOT NULL,
  route text NOT NULL CHECK (route IN ('personal_deposit','operational_float')),
  target_user_id uuid NOT NULL,
  target_user_name text,
  target_user_phone text,
  reason text NOT NULL,
  ledger_reference_id text,
  routed_by uuid NOT NULL,
  routed_by_name text,
  sms_sent boolean NOT NULL DEFAULT false,
  sms_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_routing_history_target_user ON public.email_routing_history(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_routing_history_gmail_tx ON public.email_routing_history(gmail_transaction_id);
CREATE INDEX IF NOT EXISTS idx_email_routing_history_created_at ON public.email_routing_history(created_at DESC);

ALTER TABLE public.email_routing_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Financial governance can view email routing history"
ON public.email_routing_history FOR SELECT
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Financial governance can insert email routing history"
ON public.email_routing_history FOR INSERT
WITH CHECK (
  routed_by = auth.uid() AND (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
  )
);