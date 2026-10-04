DROP POLICY IF EXISTS "Finance leadership can view SMS delivery log" ON public.sms_delivery_log;
CREATE POLICY "Finance and tech leadership can view SMS delivery log"
ON public.sms_delivery_log FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);