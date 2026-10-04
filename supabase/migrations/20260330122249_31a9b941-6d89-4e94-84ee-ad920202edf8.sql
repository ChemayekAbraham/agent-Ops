CREATE POLICY "Employees can view all landlords"
ON public.landlords
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'employee'::app_role));