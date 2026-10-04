-- Display-name resolver for agent reports.
-- Returns id, full_name, phone for the requested user ids, bypassing the per-row
-- profile RLS that prevents staff dashboards from showing every agent's name.
-- Restricted to staff/operator roles by an in-function role check.
CREATE OR REPLACE FUNCTION public.get_agent_display_names(_ids uuid[])
RETURNS TABLE (id uuid, full_name text, phone text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only staff / operator roles may resolve names in bulk.
  IF NOT (
    public.has_role(auth.uid(), 'manager'::app_role) OR
    public.has_role(auth.uid(), 'super_admin'::app_role) OR
    public.has_role(auth.uid(), 'cfo'::app_role) OR
    public.has_role(auth.uid(), 'coo'::app_role) OR
    public.has_role(auth.uid(), 'operations'::app_role) OR
    public.has_role(auth.uid(), 'hr'::app_role)
  ) THEN
    RAISE EXCEPTION 'insufficient_privileges';
  END IF;

  RETURN QUERY
  SELECT p.id, p.full_name, p.phone
  FROM public.profiles p
  WHERE p.id = ANY(_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_display_names(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_display_names(uuid[]) TO authenticated;