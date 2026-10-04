CREATE TABLE public.merchant_agreement_acceptance (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  merchant_name text,
  merchant_phone text,
  agreement_version text NOT NULL DEFAULT 'v1.0',
  accepted_at timestamp with time zone NOT NULL DEFAULT now(),
  ip_address text,
  device_info text,
  status text NOT NULL DEFAULT 'accepted',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_merchant_agreement_accepted_at ON public.merchant_agreement_acceptance (accepted_at DESC);
CREATE UNIQUE INDEX idx_merchant_agreement_agent_version ON public.merchant_agreement_acceptance (agent_id, agreement_version);

GRANT SELECT, INSERT ON public.merchant_agreement_acceptance TO authenticated;
GRANT ALL ON public.merchant_agreement_acceptance TO service_role;

ALTER TABLE public.merchant_agreement_acceptance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Merchants can insert their own acceptance"
  ON public.merchant_agreement_acceptance
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = agent_id);

CREATE POLICY "Merchants can view their own acceptance"
  ON public.merchant_agreement_acceptance
  FOR SELECT TO authenticated
  USING (auth.uid() = agent_id);

CREATE POLICY "Finance and ops staff can view all merchant acceptances"
  ON public.merchant_agreement_acceptance
  FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  );