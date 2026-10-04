-- Align manual-override (email_credit_manual_marks) access with the Financial Ops
-- panel route guard (super_admin, manager, coo, cfo). Previously coo could open
-- the panel but their manual override insert was silently blocked by RLS.

DROP POLICY IF EXISTS "Financial Ops can insert email credit marks" ON public.email_credit_manual_marks;
DROP POLICY IF EXISTS "Financial Ops can read email credit marks" ON public.email_credit_manual_marks;

CREATE POLICY "Financial Ops can insert email credit marks"
ON public.email_credit_manual_marks
FOR INSERT
TO authenticated
WITH CHECK (
  marked_by = auth.uid()
  AND (
    has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cto'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
  )
);

CREATE POLICY "Financial Ops can read email credit marks"
ON public.email_credit_manual_marks
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
);