-- Allow ops roles to edit a user's identity (full_name, phone) with audit
CREATE OR REPLACE FUNCTION public.ops_update_user_identity(
  p_user_id uuid,
  p_full_name text,
  p_phone text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_old_name text;
  v_old_phone text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_ops_role(v_caller) THEN
    RAISE EXCEPTION 'Only ops roles can edit user identity';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id required';
  END IF;
  IF coalesce(length(trim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;
  IF coalesce(length(trim(p_full_name)), 0) < 2 AND coalesce(length(trim(p_phone)), 0) < 5 THEN
    RAISE EXCEPTION 'Provide a name or phone to update';
  END IF;

  SELECT full_name, phone INTO v_old_name, v_old_phone
  FROM public.profiles WHERE id = p_user_id;

  UPDATE public.profiles
  SET
    full_name = COALESCE(NULLIF(trim(p_full_name), ''), full_name),
    phone     = COALESCE(NULLIF(trim(p_phone), ''), phone),
    updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, performed_by, metadata)
  VALUES (
    'ops_update_user_identity', 'profiles', p_user_id, trim(p_reason), v_caller,
    jsonb_build_object(
      'old_full_name', v_old_name, 'new_full_name', NULLIF(trim(p_full_name), ''),
      'old_phone', v_old_phone,    'new_phone',     NULLIF(trim(p_phone), '')
    )
  );

  INSERT INTO public.system_events (event_type, aggregate_type, aggregate_id, actor_id, payload)
  VALUES (
    'user.identity.updated', 'profile', p_user_id, v_caller,
    jsonb_build_object('reason', trim(p_reason))
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_update_user_identity(uuid, text, text, text) TO authenticated;