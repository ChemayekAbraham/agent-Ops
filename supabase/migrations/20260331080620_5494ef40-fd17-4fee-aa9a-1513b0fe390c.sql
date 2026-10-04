
CREATE OR REPLACE FUNCTION public.reset_staff_access_password(p_user_id uuid, p_reset_by uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete existing password entry so next login uses default 'WelileManager'
  DELETE FROM public.staff_access_passwords WHERE user_id = p_user_id;

  -- Log the action
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    p_reset_by,
    'staff_password_reset',
    'staff_access_passwords',
    p_user_id::text,
    jsonb_build_object(
      'target_user_id', p_user_id,
      'reset_to', 'default',
      'description', 'Manager login password reset to default'
    )
  );

  RETURN true;
END;
$$;
