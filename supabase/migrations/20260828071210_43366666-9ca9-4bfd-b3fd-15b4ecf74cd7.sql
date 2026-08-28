DROP POLICY IF EXISTS "Authenticated users can view receipt numbers" ON public.receipt_numbers;

CREATE POLICY "Owners, submitters and staff can view receipt numbers"
ON public.receipt_numbers
FOR SELECT
TO authenticated
USING (
  created_by = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.user_receipts ur
    WHERE ur.receipt_number_id = public.receipt_numbers.id
      AND ur.user_id = auth.uid()
  )
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.is_ops_role(auth.uid())
);