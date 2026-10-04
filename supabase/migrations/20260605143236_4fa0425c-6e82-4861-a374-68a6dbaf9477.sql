CREATE TABLE public.otp_login_audit (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  phone text,
  resolved_user_id uuid,
  outcome text NOT NULL,
  reason text,
  stage text,
  expected_user_id uuid,
  actual_user_id uuid,
  origin text,
  ip_address text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_otp_login_audit_created_at ON public.otp_login_audit (created_at DESC);
CREATE INDEX idx_otp_login_audit_resolved_user ON public.otp_login_audit (resolved_user_id);
CREATE INDEX idx_otp_login_audit_outcome ON public.otp_login_audit (outcome);

GRANT SELECT ON public.otp_login_audit TO authenticated;
GRANT ALL ON public.otp_login_audit TO service_role;

ALTER TABLE public.otp_login_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view OTP login audit"
ON public.otp_login_audit
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'cto')
);