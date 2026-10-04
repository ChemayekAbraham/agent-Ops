-- Allow operations and executive roles to UPDATE landlords
CREATE POLICY "Operations and executives can update landlords"
  ON public.landlords FOR UPDATE
  TO authenticated
  USING (
    has_role(auth.uid(), 'operations'::app_role) OR
    has_role(auth.uid(), 'coo'::app_role) OR
    has_role(auth.uid(), 'ceo'::app_role) OR
    has_role(auth.uid(), 'cfo'::app_role) OR
    has_role(auth.uid(), 'super_admin'::app_role)
  );

-- Allow operations and executive roles to DELETE landlords
CREATE POLICY "Operations and executives can delete landlords"
  ON public.landlords FOR DELETE
  TO authenticated
  USING (
    has_role(auth.uid(), 'operations'::app_role) OR
    has_role(auth.uid(), 'coo'::app_role) OR
    has_role(auth.uid(), 'ceo'::app_role) OR
    has_role(auth.uid(), 'cfo'::app_role) OR
    has_role(auth.uid(), 'super_admin'::app_role)
  );