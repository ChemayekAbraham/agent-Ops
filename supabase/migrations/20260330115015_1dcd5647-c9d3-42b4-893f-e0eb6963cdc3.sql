-- Allow operations staff and executives to view all landlords
CREATE POLICY "Operations and executives can view all landlords"
ON public.landlords FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
);

-- Allow operations staff and executives to view all house listings
CREATE POLICY "Operations and executives can view all house listings"
ON public.house_listings FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
);