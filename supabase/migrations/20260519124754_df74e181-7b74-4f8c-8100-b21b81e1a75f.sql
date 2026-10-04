-- Audit logger for archived/deleted login attempts.
-- SECURITY DEFINER so anon visitors hitting the login page can still write
-- a single audit row (they have no session, so the standard RLS insert
-- policy would block them).
CREATE OR REPLACE FUNCTION public.log_archived_login_attempt(
  p_identifier text,
  p_identifier_type text,           -- 'phone' | 'email'
  p_archived_user_id uuid,
  p_full_name text DEFAULT NULL,
  p_archived_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_identifier IS NULL OR length(btrim(p_identifier)) = 0 THEN
    RAISE EXCEPTION 'identifier required';
  END IF;
  IF p_identifier_type NOT IN ('phone', 'email') THEN
    RAISE EXCEPTION 'identifier_type must be phone or email';
  END IF;

  INSERT INTO public.audit_logs (
    user_id, action_type, action, table_name, record_id, metadata
  ) VALUES (
    p_archived_user_id,
    'login_failed_archived_account',
    'login_failed_archived_account',
    'auth.users',
    COALESCE(p_archived_user_id::text, p_identifier),
    jsonb_build_object(
      'identifier', p_identifier,
      'identifier_type', p_identifier_type,
      'full_name', p_full_name,
      'archived_at', p_archived_at,
      'attempted_at', now(),
      'reason', 'archived_login_block',
      'user_agent', current_setting('request.headers', true)
    )
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_archived_login_attempt(text, text, uuid, text, timestamptz) TO anon, authenticated;