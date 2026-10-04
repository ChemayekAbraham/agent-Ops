DROP POLICY IF EXISTS "Agents can view managed profiles" ON public.profiles;
CREATE POLICY "Agents can view managed profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'agent'::public.app_role)
  AND (
    referrer_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.rent_requests rr
      WHERE rr.tenant_id = profiles.id
        AND (rr.agent_id = auth.uid() OR rr.assigned_agent_id = auth.uid())
    )
    OR (managed_by_agent = true AND managing_agent_id = auth.uid())
  )
);

DROP POLICY IF EXISTS "Agents can update managed tenant contact info" ON public.profiles;
CREATE POLICY "Agents can update managed tenant contact info"
ON public.profiles
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'agent'::public.app_role)
  AND (
    referrer_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.rent_requests rr
      WHERE rr.tenant_id = profiles.id
        AND (rr.agent_id = auth.uid() OR rr.assigned_agent_id = auth.uid())
    )
    OR (managed_by_agent = true AND managing_agent_id = auth.uid())
  )
)
WITH CHECK (
  public.has_role(auth.uid(), 'agent'::public.app_role)
  AND (
    referrer_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.rent_requests rr
      WHERE rr.tenant_id = profiles.id
        AND (rr.agent_id = auth.uid() OR rr.assigned_agent_id = auth.uid())
    )
    OR (managed_by_agent = true AND managing_agent_id = auth.uid())
  )
);