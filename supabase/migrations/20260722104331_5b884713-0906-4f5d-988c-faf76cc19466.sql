CREATE POLICY "Agents can view all verified landlords"
ON public.landlords
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
  AND COALESCE(verified, false) = true
);