CREATE POLICY "CMO can view OTP login audit"
ON public.otp_login_audit
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'cmo'::app_role));