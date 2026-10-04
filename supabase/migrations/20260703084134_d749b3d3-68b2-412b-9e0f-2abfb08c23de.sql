-- Make the float_requests table reachable by the app (grants were missing).
GRANT SELECT, INSERT, UPDATE ON public.float_requests TO authenticated;
GRANT ALL ON public.float_requests TO service_role;

-- CFO / super admin / operations can review and act on any float request.
DROP POLICY IF EXISTS "Finance roles view float requests" ON public.float_requests;
CREATE POLICY "Finance roles view float requests"
ON public.float_requests
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
);

DROP POLICY IF EXISTS "Finance roles resolve float requests" ON public.float_requests;
CREATE POLICY "Finance roles resolve float requests"
ON public.float_requests
FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
)
WITH CHECK (
  has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
);