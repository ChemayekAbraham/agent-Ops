CREATE TABLE public.standing_order_notification_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scheduled_payout_id uuid,
  target_user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  attempt_number integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success','transient_failure','permanent_failure','skipped')),
  error text,
  recipient text,
  attempted_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.standing_order_notification_attempts TO authenticated;
GRANT ALL ON public.standing_order_notification_attempts TO service_role;

ALTER TABLE public.standing_order_notification_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance roles can view notification attempts"
ON public.standing_order_notification_attempts
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE INDEX idx_son_attempts_lookup
ON public.standing_order_notification_attempts (scheduled_payout_id, channel, attempt_number);