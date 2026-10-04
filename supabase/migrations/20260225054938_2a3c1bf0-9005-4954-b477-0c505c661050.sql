
-- otp_verifications: RLS enabled but no policies
-- This table is only accessed by edge functions via service_role which bypasses RLS
-- Add explicit deny policies to prevent any client-side access
CREATE POLICY "Deny all client reads on otp" ON public.otp_verifications
FOR SELECT TO authenticated USING (false);

CREATE POLICY "Deny all client inserts on otp" ON public.otp_verifications
FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY "Deny all client updates on otp" ON public.otp_verifications
FOR UPDATE TO authenticated USING (false);

CREATE POLICY "Deny all client deletes on otp" ON public.otp_verifications
FOR DELETE TO authenticated USING (false);
