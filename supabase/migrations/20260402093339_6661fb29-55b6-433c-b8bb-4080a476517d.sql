
CREATE POLICY "Managers can update lc1"
ON public.lc1_chairpersons FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'manager'))
WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can delete lc1"
ON public.lc1_chairpersons FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'manager'));
