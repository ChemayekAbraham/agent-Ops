-- Allow Landlord Operations (ops roles) to verify LC1 chairpersons, not just managers
DROP POLICY IF EXISTS "Managers can update lc1" ON public.lc1_chairpersons;

CREATE POLICY "Ops roles can update lc1"
ON public.lc1_chairpersons
FOR UPDATE
USING (public.is_ops_role(auth.uid()))
WITH CHECK (public.is_ops_role(auth.uid()));

-- Ensure ops roles can also view all lc1 rows (operations role was previously excluded)
DROP POLICY IF EXISTS "Agents and managers can view lc1" ON public.lc1_chairpersons;

CREATE POLICY "Agents and ops can view lc1"
ON public.lc1_chairpersons
FOR SELECT
USING (
  has_role(auth.uid(), 'agent'::app_role)
  OR public.is_ops_role(auth.uid())
);