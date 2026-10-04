CREATE TABLE public.standing_order_setup_notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scheduled_payout_id uuid REFERENCES public.scheduled_payouts(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  last_sent_at timestamp with time zone,
  recipient text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (scheduled_payout_id, channel)
);

GRANT SELECT ON public.standing_order_setup_notifications TO authenticated;
GRANT ALL ON public.standing_order_setup_notifications TO service_role;

ALTER TABLE public.standing_order_setup_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view standing order notifications"
ON public.standing_order_setup_notifications
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE TRIGGER update_standing_order_setup_notifications_updated_at
BEFORE UPDATE ON public.standing_order_setup_notifications
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_so_setup_notif_payout ON public.standing_order_setup_notifications(scheduled_payout_id);
CREATE INDEX idx_so_setup_notif_user ON public.standing_order_setup_notifications(target_user_id);