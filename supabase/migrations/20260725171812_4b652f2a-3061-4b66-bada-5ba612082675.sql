
CREATE OR REPLACE FUNCTION public.admin_assign_subagent_parent(
  _sub_agent_id uuid,
  _new_parent_id uuid,
  _reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _caller uuid := auth.uid();
  _has_access boolean;
  _existing_id uuid;
  _old_parent uuid;
  _sub_name text;
  _old_parent_name text;
  _new_parent_name text;
  _mode text;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  IF _sub_agent_id IS NULL OR _new_parent_id IS NULL THEN
    RAISE EXCEPTION 'Both sub-agent and parent agent must be provided';
  END IF;

  IF _sub_agent_id = _new_parent_id THEN
    RAISE EXCEPTION 'A sub-agent cannot be assigned to themselves';
  END IF;

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
    RAISE EXCEPTION 'You do not have permission to assign sub-agents';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = _sub_agent_id) THEN
    RAISE EXCEPTION 'Sub-agent profile not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = _new_parent_id) THEN
    RAISE EXCEPTION 'Parent agent profile not found';
  END IF;

  SELECT full_name INTO _sub_name FROM profiles WHERE id = _sub_agent_id;
  SELECT full_name INTO _new_parent_name FROM profiles WHERE id = _new_parent_id;

  SELECT id, parent_agent_id INTO _existing_id, _old_parent
  FROM agent_subagents WHERE sub_agent_id = _sub_agent_id;

  IF _existing_id IS NOT NULL THEN
    IF _old_parent = _new_parent_id THEN
      RAISE EXCEPTION '% is already a sub-agent of %', _sub_name, _new_parent_name;
    END IF;
    SELECT full_name INTO _old_parent_name FROM profiles WHERE id = _old_parent;

    UPDATE agent_subagents
    SET parent_agent_id = _new_parent_id,
        source = 'admin_assignment',
        status = 'verified',
        verified_at = COALESCE(verified_at, now()),
        verified_by = _caller
    WHERE id = _existing_id;

    _mode := 'reassigned';
  ELSE
    INSERT INTO agent_subagents (
      parent_agent_id, sub_agent_id, source, status, verified_at, verified_by, accepted_at
    ) VALUES (
      _new_parent_id, _sub_agent_id, 'admin_assignment', 'verified', now(), _caller, now()
    ) RETURNING id INTO _existing_id;

    _mode := 'created';
  END IF;

  INSERT INTO audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (
    _caller,
    CASE WHEN _mode = 'reassigned' THEN 'subagent_transfer' ELSE 'subagent_admin_assignment' END,
    CASE WHEN _mode = 'reassigned'
      THEN 'Admin reassigned sub-agent to a new parent agent'
      ELSE 'Admin assigned agent as sub-agent to a parent agent' END,
    'agent_subagents',
    _existing_id::text,
    jsonb_build_object(
      'reason', trim(_reason),
      'sub_agent_id', _sub_agent_id,
      'sub_agent_name', _sub_name,
      'old_parent_id', _old_parent,
      'old_parent_name', _old_parent_name,
      'new_parent_id', _new_parent_id,
      'new_parent_name', _new_parent_name,
      'mode', _mode,
      'performed_via', 'admin_assign_subagent_parent'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'mode', _mode,
    'record_id', _existing_id,
    'sub_agent_id', _sub_agent_id,
    'new_parent_id', _new_parent_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_assign_subagent_parent(uuid, uuid, text) TO authenticated, service_role;
