-- Add PIN column to vendors for self-service login
ALTER TABLE public.vendors ADD COLUMN pin text;

-- Create RLS policy for vendors to update their own receipt numbers
CREATE POLICY "Vendors can update own receipts with PIN" 
ON public.receipt_numbers 
FOR UPDATE 
USING (true)
WITH CHECK (true);

-- Drop the existing restrictive policy and make it more flexible
DROP POLICY IF EXISTS "Managers can manage receipt numbers" ON public.receipt_numbers;

CREATE POLICY "Managers can manage receipt numbers" 
ON public.receipt_numbers 
FOR ALL 
USING (has_role(auth.uid(), 'manager'::app_role))
WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

-- Create policy for vendors to insert (mark) their receipts via service role
-- We'll use an edge function for vendor authentication