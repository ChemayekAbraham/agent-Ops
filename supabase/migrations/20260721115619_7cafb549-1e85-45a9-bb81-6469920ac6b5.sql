CREATE OR REPLACE FUNCTION public.release_sub_agent(p_sub_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_link public.agent_subagents%ROWTYPE;
  v_remaining int;
  v_cleared_referrer boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_link
  FROM public.agent_subagents
  WHERE sub_agent_id = p_sub_agent_id
    AND parent_agent_id = auth.uid()
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This sub-agent is not linked to you';
  END IF;

  -- Fully remove the link so the sub-agent becomes independent and can
  -- be reinvited by anyone (the unique_subagent constraint would block
  -- reinvitation if we only soft-released the row).
  DELETE FROM public.agent_subagents WHERE id = v_link.id;

  -- Clear referrer_id on the sub-agent's profile ONLY if it still points
  -- at the parent doing the unlink. Never touch unrelated referrals.
  UPDATE public.profiles
  SET referrer_id = NULL
  WHERE id = p_sub_agent_id
    AND referrer_id = auth.uid();
  GET DIAGNOSTICS v_cleared_referrer = ROW_COUNT;

  -- Deactivate parent capability if no verified sub-agents remain.
  SELECT count(*) INTO v_remaining
  FROM public.agent_subagents
  WHERE parent_agent_id = auth.uid()
    AND status = 'verified';

  IF v_remaining = 0 THEN
    UPDATE public.agent_capabilities
    SET status = 'inactive'
    WHERE agent_id = auth.uid()
      AND capability = 'manage_subagents';
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    auth.uid(),
    'release_sub_agent',
    'agent_subagents',
    v_link.id::text,
    jsonb_build_object(
      'sub_agent_id', p_sub_agent_id,
      'previous_status', v_link.status,
      'cleared_referrer', v_cleared_referrer,
      'reason', 'Parent agent unlinked sub-agent; link removed so sub-agent is now independent and reinvitable'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'sub_agent_id', p_sub_agent_id,
    'unlinked', true,
    'cleared_referrer', v_cleared_referrer
  );
END;
$function$;