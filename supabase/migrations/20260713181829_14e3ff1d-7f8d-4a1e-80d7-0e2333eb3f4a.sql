DROP POLICY IF EXISTS "Agents can browse all landlords for rental finder" ON public.landlords;
DROP POLICY IF EXISTS "Employees can view all landlords" ON public.landlords;
DROP POLICY IF EXISTS "Employees can view all landlords for ops" ON public.landlords;
DROP POLICY IF EXISTS "Agents can view associated landlords" ON public.landlords;
DROP POLICY IF EXISTS "Employees can view associated landlords" ON public.landlords;

CREATE POLICY "Agents can view associated landlords"
  ON public.landlords FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'agent'::app_role)
         AND public.user_can_access_landlord(id, auth.uid()));

CREATE POLICY "Employees can view associated landlords"
  ON public.landlords FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'employee'::app_role)
         AND public.user_can_access_landlord(id, auth.uid()));