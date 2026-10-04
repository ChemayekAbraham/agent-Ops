
CREATE TABLE public.otp_send_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NULL,
  phone TEXT NOT NULL,
  ip TEXT NULL,
  outcome TEXT NOT NULL DEFAULT 'sent',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_otp_send_events_phone_created ON public.otp_send_events (phone, created_at DESC);
CREATE INDEX idx_otp_send_events_user_created ON public.otp_send_events (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_otp_send_events_ip_created ON public.otp_send_events (ip, created_at DESC) WHERE ip IS NOT NULL;

GRANT ALL ON public.otp_send_events TO service_role;

ALTER TABLE public.otp_send_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages otp_send_events"
  ON public.otp_send_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
