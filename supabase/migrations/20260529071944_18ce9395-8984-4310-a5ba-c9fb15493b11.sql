CREATE TABLE public.sms_delivery_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  recipient_phone TEXT NOT NULL,
  recipient_user_id UUID,
  recipient_name TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'failed',
  provider TEXT NOT NULL DEFAULT 'africastalking',
  provider_message_id TEXT,
  provider_response JSONB,
  cost TEXT,
  reference_id TEXT,
  source TEXT,
  error TEXT
);

CREATE INDEX idx_sms_delivery_log_created_at ON public.sms_delivery_log (created_at DESC);
CREATE INDEX idx_sms_delivery_log_reference_id ON public.sms_delivery_log (reference_id);
CREATE INDEX idx_sms_delivery_log_status ON public.sms_delivery_log (status);
CREATE INDEX idx_sms_delivery_log_recipient_user ON public.sms_delivery_log (recipient_user_id);

GRANT SELECT ON public.sms_delivery_log TO authenticated;
GRANT ALL ON public.sms_delivery_log TO service_role;

ALTER TABLE public.sms_delivery_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leadership can view SMS delivery log"
ON public.sms_delivery_log
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'super_admin')
);