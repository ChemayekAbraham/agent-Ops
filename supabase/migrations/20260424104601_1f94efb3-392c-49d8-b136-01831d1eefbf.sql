
-- 1. Expand default agent kit: add manage_subagents, approve_subagents, view_subagent_data
CREATE OR REPLACE FUNCTION public.grant_default_agent_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.role = 'agent' AND NEW.enabled = true THEN
    INSERT INTO public.agent_capabilities (agent_id, capability)
    SELECT NEW.user_id, cap
    FROM unnest(ARRAY[
      'collect_rent','onboard_tenants','onboard_landlords',
      'capture_supporters','view_agent_dashboard','request_float',
      'manage_subagents','approve_subagents','view_subagent_data'
    ]) AS cap
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. Helper: can viewer see target's data based on sub-agent tree?
--    Returns true if viewer == target, or if target is a verified sub-agent of viewer.
CREATE OR REPLACE FUNCTION public.can_view_agent_data(_viewer_id uuid, _target_agent_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    _viewer_id = _target_agent_id
    OR (
      public.has_agent_capability(_viewer_id, 'view_subagent_data')
      AND EXISTS (
        SELECT 1 FROM public.agent_subagents s
        WHERE s.parent_agent_id = _viewer_id
          AND s.sub_agent_id = _target_agent_id
          AND s.status = 'verified'
      )
    );
$function$;
