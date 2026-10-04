
CREATE OR REPLACE FUNCTION public.ops_link_user_to_agent(
  p_user_id uuid,
  p_agent_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_ops boolean;
  v_old_agent uuid;
  v_agent_is_agent boolean;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_user_id IS NULL OR p_agent_id IS NULL THEN
    RAISE EXCEPTION 'user_id and agent_id are required';
  END IF;
  IF p_user_id = p_agent_id THEN
    RAISE EXCEPTION 'A user cannot be linked to themselves as agent';
  END IF;
  IF coalesce(length(trim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  SELECT public.is_ops_role(v_caller) INTO v_is_ops;
  IF NOT v_is_ops THEN
    RAISE EXCEPTION 'Only ops roles can link users to agents';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_agent_id AND role = 'agent' AND enabled = true
  ) INTO v_agent_is_agent;
  IF NOT v_agent_is_agent THEN
    RAISE EXCEPTION 'Target user is not an active agent';
  END IF;

  SELECT managing_agent_id INTO v_old_agent
  FROM public.profiles WHERE id = p_user_id;

  UPDATE public.profiles
     SET managing_agent_id = p_agent_id,
         managed_by_agent  = true,
         referrer_id       = COALESCE(referrer_id, p_agent_id),
         updated_at        = now()
   WHERE id = p_user_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, performed_by, reason, metadata)
  VALUES (
    'link_user_to_agent', 'profiles', p_user_id, v_caller, trim(p_reason),
    jsonb_build_object('old_agent_id', v_old_agent, 'new_agent_id', p_agent_id)
  );

  INSERT INTO public.system_events (event_type, actor_id, payload)
  VALUES (
    'ops.user.linked_to_agent', v_caller,
    jsonb_build_object(
      'user_id', p_user_id,
      'agent_id', p_agent_id,
      'old_agent_id', v_old_agent,
      'reason', trim(p_reason)
    )
  );

  RETURN jsonb_build_object('ok', true, 'user_id', p_user_id, 'agent_id', p_agent_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_link_user_to_agent(uuid, uuid, text) TO authenticated;
