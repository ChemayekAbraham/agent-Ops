GRANT SELECT, INSERT, UPDATE ON public.opportunity_summaries TO authenticated;
GRANT ALL ON public.opportunity_summaries TO service_role;

DROP POLICY IF EXISTS "Managers and supporters can view summaries" ON public.opportunity_summaries;
DROP POLICY IF EXISTS "Managers can insert opportunity summaries" ON public.opportunity_summaries;
DROP POLICY IF EXISTS "Managers can update opportunity summaries" ON public.opportunity_summaries;

CREATE POLICY "Staff and supporters can view summaries"
ON public.opportunity_summaries FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'supporter')
  OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Finance leadership can insert summaries"
ON public.opportunity_summaries FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Finance leadership can update summaries"
ON public.opportunity_summaries FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
);