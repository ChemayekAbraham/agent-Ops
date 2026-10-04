
-- Drop the overly permissive update policy
DROP POLICY IF EXISTS "Vendors can update own receipts with PIN" ON public.receipt_numbers;

-- Only managers can update receipt_numbers via direct DB access
-- Vendor updates happen through the vendor-mark-receipt edge function (service role)
CREATE POLICY "Only managers can update receipt numbers"
ON public.receipt_numbers FOR UPDATE
USING (has_role(auth.uid(), 'manager'::app_role))
WITH CHECK (has_role(auth.uid(), 'manager'::app_role));
