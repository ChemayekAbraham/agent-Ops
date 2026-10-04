CREATE TABLE public.sms_broadcast_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_key text NOT NULL,
  phone text NOT NULL,
  status text NOT NULL DEFAULT 'sent',
  provider text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_key, phone)
);

CREATE INDEX idx_sms_broadcast_log_campaign ON public.sms_broadcast_log (campaign_key, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sms_broadcast_log TO authenticated;
GRANT ALL ON public.sms_broadcast_log TO service_role;

ALTER TABLE public.sms_broadcast_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view broadcast log"
ON public.sms_broadcast_log
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'cmo')
  OR public.has_role(auth.uid(), 'crm')
);