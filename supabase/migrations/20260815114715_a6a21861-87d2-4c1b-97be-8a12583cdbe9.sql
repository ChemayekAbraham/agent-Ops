-- Same authorization semantics, evaluated once per statement instead of per row.
-- public.has_role() is SECURITY DEFINER, so it does not re-enter user_roles RLS
-- (which itself calls has_role five times over a 221k-row table).
DROP POLICY IF EXISTS "Managers view all draws" ON public.credit_access_draws;
CREATE POLICY "Managers view all draws"
ON public.credit_access_draws
FOR SELECT
TO authenticated
USING (
  public.has_role((select auth.uid()), 'manager'::app_role)
  OR public.has_role((select auth.uid()), 'coo'::app_role)
  OR public.has_role((select auth.uid()), 'cfo'::app_role)
);

DROP POLICY IF EXISTS "Users view own draws" ON public.credit_access_draws;
CREATE POLICY "Users view own draws"
ON public.credit_access_draws
FOR SELECT
TO authenticated
USING (
  (select auth.uid()) = user_id
  OR (select auth.uid()) = agent_id
);

DROP POLICY IF EXISTS "Staff update draws" ON public.credit_access_draws;
CREATE POLICY "Staff update draws"
ON public.credit_access_draws
FOR UPDATE
TO authenticated
USING (
  public.has_role((select auth.uid()), 'manager'::app_role)
  OR public.has_role((select auth.uid()), 'coo'::app_role)
  OR public.has_role((select auth.uid()), 'cfo'::app_role)
  OR public.has_role((select auth.uid()), 'super_admin'::app_role)
);

CREATE INDEX IF NOT EXISTS idx_credit_access_draws_user_agent
  ON public.credit_access_draws (user_id, agent_id);