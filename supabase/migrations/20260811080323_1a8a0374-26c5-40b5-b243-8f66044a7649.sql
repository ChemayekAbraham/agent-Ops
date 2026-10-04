-- Vetting eligibility: formal manager OR any agent with >=1 verified sub-agent.
CREATE OR REPLACE FUNCTION public.is_service_center_manager(p_agent_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_agent_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.service_center_managers
      WHERE agent_id = p_agent_id AND status = 'active'
    )
    OR EXISTS (
      SELECT 1
      FROM public.agent_subagents s
      JOIN public.profiles sp ON sp.id = s.sub_agent_id
      WHERE s.parent_agent_id = p_agent_id
        AND s.status = 'verified'
        AND s.sub_agent_id <> p_agent_id
        AND COALESCE(sp.is_frozen, false) = false
    )
  );
$function$;

-- Route the still-unvetted rent requests to their newly eligible team leader.
WITH targets AS (
  SELECT rr.id,
         public.resolve_service_center_manager_for_agent(
           COALESCE(rr.agent_id, rr.assigned_agent_id)
         ) AS mgr
  FROM public.rent_requests rr
  WHERE rr.status = 'pending'
    AND rr.service_center_manager_id IS NULL
)
UPDATE public.rent_requests rr
SET status = 'service_center_review',
    service_center_manager_id = t.mgr
FROM targets t
WHERE rr.id = t.id
  AND t.mgr IS NOT NULL;