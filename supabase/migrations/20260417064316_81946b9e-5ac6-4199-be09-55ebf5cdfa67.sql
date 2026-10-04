CREATE OR REPLACE FUNCTION public.verify_subagent(
  _record_id uuid,
  _action text,
  _rejection_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _has_access boolean;
  _updated_id uuid;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF _action NOT IN ('verify', 'reject') THEN
    RAISE EXCEPTION 'Invalid action: %', _action;
  END IF;

  -- Permission check
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
    RAISE EXCEPTION 'You do not have permission to verify sub-agents';
  END IF;

  IF _action = 'verify' THEN
    UPDATE agent_subagents
    SET status = 'verified',
        verified_by = _caller,
        verified_at = now()
    WHERE id = _record_id
    RETURNING id INTO _updated_id;
  ELSE
    IF _rejection_reason IS NULL OR length(trim(_rejection_reason)) < 10 THEN
      RAISE EXCEPTION 'Rejection reason must be at least 10 characters';
    END IF;
    UPDATE agent_subagents
    SET status = 'rejected',
        rejection_reason = trim(_rejection_reason)
    WHERE id = _record_id
    RETURNING id INTO _updated_id;
  END IF;

  IF _updated_id IS NULL THEN
    RAISE EXCEPTION 'Sub-agent record not found';
  END IF;

  RETURN jsonb_build_object('success', true, 'id', _updated_id, 'action', _action);
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_subagent(uuid, text, text) TO authenticated;