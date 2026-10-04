-- Doc 175: DB CPU pressure. promissory_notes (30% of DB time) and user_roles policies
-- re-ran their role checks once per row. Same access rules, evaluated once per statement.
--
-- * promissory_notes admin policies queried user_roles directly per row, which also
--   re-triggered user_roles' own SELECT policy (5x has_role per row).
-- * user_roles "Users can view roles" called has_role() 5 times per row.
--
-- Wrapping a STABLE function call in (select ...) makes Postgres plan it as an InitPlan
-- (evaluated once). Helpers are SECURITY DEFINER so they skip user_roles RLS (no recursion).
--
-- Behaviour is intentionally unchanged:
--   * current_user_has_any_role_ignoring_enabled mirrors the old promissory_notes
--     subquery, which never checked user_roles.enabled.
--   * current_user_has_enabled_role mirrors has_role(), which does check enabled.

CREATE OR REPLACE FUNCTION public.current_user_has_any_role_ignoring_enabled(_roles public.app_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = ANY (_roles)
  )
$$;

CREATE OR REPLACE FUNCTION public.current_user_has_enabled_role(_roles public.app_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = ANY (_roles) AND enabled = true
  )
$$;

REVOKE ALL ON FUNCTION public.current_user_has_any_role_ignoring_enabled(public.app_role[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_user_has_enabled_role(public.app_role[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_has_any_role_ignoring_enabled(public.app_role[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_user_has_enabled_role(public.app_role[]) TO authenticated, service_role;

-- promissory_notes -----------------------------------------------------------
ALTER POLICY "Admin roles can delete promissory notes" ON public.promissory_notes
  USING ((SELECT public.current_user_has_any_role_ignoring_enabled(
    ARRAY['operations','cfo','coo','super_admin','manager','ceo']::public.app_role[])));

ALTER POLICY "Admin roles can update promissory notes" ON public.promissory_notes
  USING ((SELECT public.current_user_has_any_role_ignoring_enabled(
    ARRAY['operations','cfo','coo','super_admin','manager','partner_ops','agent_ops']::public.app_role[])));

ALTER POLICY "Admin roles can view all promissory notes" ON public.promissory_notes
  USING ((SELECT public.current_user_has_any_role_ignoring_enabled(
    ARRAY['operations','cfo','coo','super_admin','manager','partner_ops','agent_ops']::public.app_role[])));

ALTER POLICY "Agents can create promissory notes" ON public.promissory_notes
  WITH CHECK (agent_id = (SELECT auth.uid()));

ALTER POLICY "Agents can update own pending notes" ON public.promissory_notes
  USING (agent_id = (SELECT auth.uid()) AND status = 'pending');

ALTER POLICY "Agents can view own promissory notes" ON public.promissory_notes
  USING (agent_id = (SELECT auth.uid()));

ALTER POLICY "Partners can view own linked notes" ON public.promissory_notes
  USING (partner_user_id = (SELECT auth.uid()));

-- user_roles -----------------------------------------------------------------
ALTER POLICY "Users can view roles" ON public.user_roles
  USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT public.current_user_has_enabled_role(
      ARRAY['manager','super_admin','ceo','coo','cfo']::public.app_role[]))
  );
