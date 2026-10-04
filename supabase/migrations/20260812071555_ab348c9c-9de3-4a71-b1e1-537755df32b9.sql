CREATE OR REPLACE FUNCTION public.resolve_service_center_manager_for_agent(p_agent_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parent uuid;
BEGIN
  IF p_agent_id IS NULL THEN RETURN NULL; END IF;

  -- Rule: as long as the submitter is a sub-agent, their DIRECT verified parent
  -- vets them -- regardless of whether the submitter (or the parent) manages
  -- sub-agents of their own. Nobody can vet their own submission.
  SELECT s.parent_agent_id INTO v_parent
  FROM public.agent_subagents s
  WHERE s.sub_agent_id = p_agent_id
    AND s.status = 'verified'
    AND s.parent_agent_id <> p_agent_id
  ORDER BY s.verified_at DESC NULLS LAST, s.created_at DESC
  LIMIT 1;

  -- No verified parent -> NULL, submission goes straight to Agent Ops.
  RETURN v_parent;
END;
$function$;