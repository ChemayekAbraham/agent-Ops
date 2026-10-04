CREATE TABLE public.landlord_payout_otp_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge_id uuid NOT NULL REFERENCES public.landlord_payout_otp_challenges(id) ON DELETE CASCADE,
  agent_id uuid,
  landlord_id uuid,
  event_type text NOT NULL,
  landlord_phone text,
  amount numeric,
  otp_expires_at timestamp with time zone,
  detail text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_landlord_payout_otp_events_challenge ON public.landlord_payout_otp_events(challenge_id, created_at);
CREATE INDEX idx_landlord_payout_otp_events_agent ON public.landlord_payout_otp_events(agent_id, created_at DESC);

GRANT SELECT ON public.landlord_payout_otp_events TO authenticated;
GRANT ALL ON public.landlord_payout_otp_events TO service_role;

ALTER TABLE public.landlord_payout_otp_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view their own OTP events"
ON public.landlord_payout_otp_events
FOR SELECT
TO authenticated
USING (
  agent_id = auth.uid()
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Service role manages OTP events"
ON public.landlord_payout_otp_events
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);