-- Server-side staff access code redemption. Bypasses user_roles RLS for the
-- self-grant of the 'manager' role, but only when the caller provides the
-- exact admin access code.
CREATE OR REPLACE FUNCTION public.redeem_staff_access_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_expected_code text := 'Manager@welile';
  v_existing_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF p_code IS NULL OR p_code <> v_expected_code THEN
    -- Best-effort audit of failed attempts (do not block on failure)
    BEGIN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      VALUES (v_uid, 'staff_access_code_failed', 'user_roles', v_uid,
              'invalid staff access code attempt',
              jsonb_build_object('method', 'access_code'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN jsonb_build_object('success', false, 'error', 'invalid_code');
  END IF;

  -- Re-enable if exists (disabled), otherwise insert
  SELECT id INTO v_existing_id
  FROM public.user_roles
  WHERE user_id = v_uid AND role = 'manager'::app_role
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.user_roles SET enabled = true WHERE id = v_existing_id;
  ELSE
    INSERT INTO public.user_roles (user_id, role, enabled)
    VALUES (v_uid, 'manager'::app_role, true);
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (v_uid, 'staff_access_granted', 'user_roles', v_uid,
            'staff access via Manager@welile code',
            jsonb_build_object('method', 'access_code', 'role', 'manager'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'role', 'manager');
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_staff_access_code(text) TO authenticated;