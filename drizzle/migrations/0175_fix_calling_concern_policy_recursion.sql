-- Break the circular RLS dependency between forwarded concerns and their append-only event trail.
-- The SECURITY DEFINER helper evaluates membership without invoking either table's policies.
CREATE OR REPLACE FUNCTION public.cc_can_view_concern(
  p_concern_id uuid,
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.cc_forwarded_concerns c
     WHERE c.id = p_concern_id
       AND (
         c.forwarded_to = p_user_id
         OR c.forwarded_by = p_user_id
         OR c.original_forwarded_to = p_user_id
         OR EXISTS (
           SELECT 1
             FROM public.cc_forwarded_concern_events e
            WHERE e.concern_id = c.id
              AND p_user_id IN (e.actor_id, e.prev_user_id, e.new_user_id)
         )
         OR public.has_role(p_user_id, 'hr'::public.app_role)
         OR public.has_role(p_user_id, 'ceo'::public.app_role)
         OR public.has_role(p_user_id, 'coo'::public.app_role)
         OR public.has_role(p_user_id, 'tenant_ops'::public.app_role)
         OR public.has_role(p_user_id, 'manager'::public.app_role)
         OR public.has_role(p_user_id, 'super_admin'::public.app_role)
       )
  );
$$;

REVOKE ALL ON FUNCTION public.cc_can_view_concern(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_can_view_concern(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS cc_fc_select_scoped ON public.cc_forwarded_concerns;
CREATE POLICY cc_fc_select_scoped ON public.cc_forwarded_concerns
FOR SELECT TO authenticated
USING (public.cc_can_view_concern(id, auth.uid()));

DROP POLICY IF EXISTS cc_fce_select_scoped ON public.cc_forwarded_concern_events;
CREATE POLICY cc_fce_select_scoped ON public.cc_forwarded_concern_events
FOR SELECT TO authenticated
USING (public.cc_can_view_concern(concern_id, auth.uid()));

COMMENT ON FUNCTION public.cc_can_view_concern(uuid, uuid) IS
'Non-recursive access check for Calling Center concerns and their append-only event history.';