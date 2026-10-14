-- Food Coordinator handover: the successor picker.
--
-- NOT APPLIED TO PRODUCTION. Sandbox-tested only.
--
-- The handover screen previously had no way to choose a successor against the
-- live service — only fixture identities — so the control was inert outside
-- the development environment.
--
-- IDENTITY SOURCE
-- This reads the same authoritative source the rest of the product uses to
-- answer "who is an employee": `user_roles.role = 'employee'` joined to
-- `profiles`, returning id and name only. No department, pay, contact detail
-- or any other personal field is exposed.
--
-- WHY NOT REUSE cc_forward_staff_options()
-- That is the closest existing picker and the shape is copied from it, but it
-- also excludes PSO officers — a Calling Center routing rule that has no
-- meaning here and would silently bar a PSO officer from ever being made Food
-- Coordinator. Food must not inherit another module's policy, so the source is
-- shared and the filter is not.
--
-- ACCESS
-- Unlike cc_forward_staff_options, which any signed-in user may call, this is
-- restricted to the ACTIVE Food Coordinator. Nobody else has a reason to
-- enumerate staff from the food feature, and a handover is the only thing this
-- list feeds.

CREATE OR REPLACE FUNCTION public.food_coordinator_candidates()
RETURNS TABLE(user_id uuid, full_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_food_coordinator(auth.uid()) THEN
    RAISE EXCEPTION 'Only the active Food Coordinator may look up a successor'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ur.user_id,
         coalesce(nullif(btrim(p.full_name), ''), 'Staff member') AS full_name
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
   WHERE ur.role = 'employee'
     AND coalesce(ur.enabled, true)
     AND p.deleted_at IS NULL
     -- a handover to yourself is refused by food_transfer_coordinator; do not
     -- offer it in the first place
     AND ur.user_id <> auth.uid()
   ORDER BY 2;
END;
$$;

REVOKE ALL ON FUNCTION public.food_coordinator_candidates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.food_coordinator_candidates() TO authenticated;
