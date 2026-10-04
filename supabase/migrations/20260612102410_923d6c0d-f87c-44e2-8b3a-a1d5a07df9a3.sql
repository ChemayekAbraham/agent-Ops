CREATE OR REPLACE FUNCTION public.release_sub_agent(p_sub_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link public.agent_subagents%ROWTYPE;
  v_remaining int;
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

  IF v_link.status = 'released' THEN
    RETURN jsonb_build_object('ok', true, 'already_released', true);
  END IF;

  -- End the relationship. is_sub_agent / is_parent_agent only count
  -- status = 'verified', so all parent benefits (override commission,
  -- network visibility) cease immediately.
  UPDATE public.agent_subagents
  SET status = 'released',
      acceptance_token = NULL,
      expires_at = NULL,
      rejection_reason = 'Released by parent agent'
  WHERE id = v_link.id;

  -- If the parent has no other verified sub-agents, revoke the
  -- manage_subagents capability so the panel no longer surfaces.
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

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, details)
  VALUES (
    auth.uid(),
    'release_sub_agent',
    'agent_subagents',
    v_link.id,
    jsonb_build_object(
      'sub_agent_id', p_sub_agent_id,
      'previous_status', v_link.status,
      'reason', 'Parent agent released sub-agent; benefits ceased'
    )
  );

  RETURN jsonb_build_object('ok', true, 'sub_agent_id', p_sub_agent_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_sub_agent(uuid) TO authenticated;