-- Bind the non-recursive concern membership check to the active session.
-- The retained second argument preserves compatibility but cannot impersonate another user.
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
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.cc_forwarded_concerns c
     WHERE c.id = p_concern_id
       AND (
         c.forwarded_to = auth.uid()
         OR c.forwarded_by = auth.uid()
         OR c.original_forwarded_to = auth.uid()
         OR EXISTS (
           SELECT 1
             FROM public.cc_forwarded_concern_events e
            WHERE e.concern_id = c.id
              AND auth.uid() IN (e.actor_id, e.prev_user_id, e.new_user_id)
         )
         OR public.has_role(auth.uid(), 'hr'::public.app_role)
         OR public.has_role(auth.uid(), 'ceo'::public.app_role)
         OR public.has_role(auth.uid(), 'coo'::public.app_role)
         OR public.has_role(auth.uid(), 'tenant_ops'::public.app_role)
         OR public.has_role(auth.uid(), 'manager'::public.app_role)
         OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
       )
  );
$$;

COMMENT ON FUNCTION public.cc_can_view_concern(uuid, uuid) IS
'Non-recursive current-session access check for Calling Center concerns and append-only event history; p_user_id is retained only for signature compatibility.';