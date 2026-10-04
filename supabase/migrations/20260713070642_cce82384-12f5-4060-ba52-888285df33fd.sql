CREATE OR REPLACE FUNCTION public.reassign_subagent_parent(
  _record_id uuid,
  _new_parent_id uuid,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _has_access boolean;
  _old_parent uuid;
  _sub_agent uuid;
  _old_parent_name text;
  _new_parent_name text;
  _sub_name text;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  -- Permission check (mirrors verify_subagent)
  SELECT (
    has_role(_caller, 'super_admin'::app_role)
    OR has_role(_caller, 'cto'::app_role)
    OR has_role(_caller, 'manager'::app_role)
    OR has_role(_caller, 'operations'::app_role)
    OR has_role(_caller, 'coo'::app_role)
    OR EXISTS (
      SELECT 1 FROM staff_permissions sp
      WHERE sp.user_id = _caller
        AND sp.permitted_dashboard IN ('agent_ops', 'agent_operations', 'agent_ops_admin', 'executive_hub')
    )
  ) INTO _has_access;

  IF NOT _has_access THEN
    RAISE EXCEPTION 'You do not have permission to transfer sub-agents';
  END IF;

  SELECT parent_agent_id, sub_agent_id INTO _old_parent, _sub_agent
  FROM agent_subagents WHERE id = _record_id;

  IF _old_parent IS NULL THEN
    RAISE EXCEPTION 'Sub-agent record not found';
  END IF;

  IF _new_parent_id = _old_parent THEN
    RAISE EXCEPTION 'New parent agent is the same as the current parent';
  END IF;

  IF _new_parent_id = _sub_agent THEN
    RAISE EXCEPTION 'A sub-agent cannot be assigned to themselves';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = _new_parent_id) THEN
    RAISE EXCEPTION 'New parent agent not found';
  END IF;

  SELECT full_name INTO _old_parent_name FROM profiles WHERE id = _old_parent;
  SELECT full_name INTO _new_parent_name FROM profiles WHERE id = _new_parent_id;
  SELECT full_name INTO _sub_name FROM profiles WHERE id = _sub_agent;

  UPDATE agent_subagents
  SET parent_agent_id = _new_parent_id
  WHERE id = _record_id;

  INSERT INTO audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (
    _caller,
    'subagent_transfer',
    'Transferred sub-agent to a new parent agent',
    'agent_subagents',
    _record_id::text,
    jsonb_build_object(
      'reason', trim(_reason),
      'sub_agent_id', _sub_agent,
      'sub_agent_name', _sub_name,
      'old_parent_id', _old_parent,
      'old_parent_name', _old_parent_name,
      'new_parent_id', _new_parent_id,
      'new_parent_name', _new_parent_name,
      'transferred_at', now()
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'id', _record_id,
    'old_parent_id', _old_parent,
    'new_parent_id', _new_parent_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reassign_subagent_parent(uuid, uuid, text) TO authenticated;