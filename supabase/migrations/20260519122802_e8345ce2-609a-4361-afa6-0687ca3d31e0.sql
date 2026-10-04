-- Admin-only helper to clear auth.users.deleted_at (soft-deletion) on an account.
-- Called from the restore-archived-account edge function (service role only).
CREATE OR REPLACE FUNCTION public.admin_restore_auth_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before timestamptz;
BEGIN
  SELECT deleted_at INTO v_before FROM auth.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_not_found');
  END IF;

  UPDATE auth.users
     SET deleted_at = NULL,
         banned_until = NULL,
         updated_at = now()
   WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', p_user_id,
    'previous_deleted_at', v_before
  );
END;
$$;

-- Lock down: only service_role may execute this.
REVOKE ALL ON FUNCTION public.admin_restore_auth_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_restore_auth_user(uuid) TO service_role;