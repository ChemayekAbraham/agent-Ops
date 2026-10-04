CREATE TABLE public.withdrawal_notification_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  withdrawal_id uuid,
  recipient_id uuid,
  recipient_email text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'sent',
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.withdrawal_notification_log TO authenticated;
GRANT ALL ON public.withdrawal_notification_log TO service_role;

ALTER TABLE public.withdrawal_notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops roles can view withdrawal notification log"
ON public.withdrawal_notification_log
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'cto')
);

CREATE INDEX idx_withdrawal_notification_log_withdrawal
  ON public.withdrawal_notification_log (withdrawal_id);
CREATE INDEX idx_withdrawal_notification_log_created
  ON public.withdrawal_notification_log (created_at DESC);