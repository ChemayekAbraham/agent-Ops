CREATE POLICY "Operations and executives can update house listings"
ON public.house_listings
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'operations') OR
  public.has_role(auth.uid(), 'manager') OR
  public.has_role(auth.uid(), 'coo') OR
  public.has_role(auth.uid(), 'ceo') OR
  public.has_role(auth.uid(), 'cfo') OR
  public.has_role(auth.uid(), 'super_admin') OR
  public.has_role(auth.uid(), 'cto')
)
WITH CHECK (
  public.has_role(auth.uid(), 'operations') OR
  public.has_role(auth.uid(), 'manager') OR
  public.has_role(auth.uid(), 'coo') OR
  public.has_role(auth.uid(), 'ceo') OR
  public.has_role(auth.uid(), 'cfo') OR
  public.has_role(auth.uid(), 'super_admin') OR
  public.has_role(auth.uid(), 'cto')
);