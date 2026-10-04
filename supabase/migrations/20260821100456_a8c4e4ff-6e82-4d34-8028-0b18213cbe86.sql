-- 1. Register table
CREATE TABLE IF NOT EXISTS public.deleted_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  full_name text,
  email text,
  phone text,
  national_id text,
  roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'soft_deleted',
  reason text NOT NULL,
  deleted_by uuid,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  purged_by uuid,
  purged_at timestamptz,
  purge_reason text,
  restored_by uuid,
  restored_at timestamptz,
  restore_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deleted_accounts_status_check CHECK (status IN ('soft_deleted','purged','restored'))
);

GRANT SELECT ON public.deleted_accounts TO authenticated;
GRANT ALL ON public.deleted_accounts TO service_role;
ALTER TABLE public.deleted_accounts ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS deleted_accounts_active_user_uidx
  ON public.deleted_accounts (user_id) WHERE status = 'soft_deleted';
CREATE INDEX IF NOT EXISTS deleted_accounts_status_idx ON public.deleted_accounts (status, deleted_at DESC);

CREATE OR REPLACE FUNCTION public.can_manage_deleted_accounts(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id
      AND role IN ('manager','cto','super_admin')
      AND COALESCE(enabled, true)
  )
$$;

DROP POLICY IF EXISTS "Admins view deleted accounts" ON public.deleted_accounts;
CREATE POLICY "Admins view deleted accounts" ON public.deleted_accounts
FOR SELECT TO authenticated
USING (public.can_manage_deleted_accounts((SELECT auth.uid())));

CREATE OR REPLACE FUNCTION public.touch_deleted_accounts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_deleted_accounts ON public.deleted_accounts;
CREATE TRIGGER trg_touch_deleted_accounts BEFORE UPDATE ON public.deleted_accounts
FOR EACH ROW EXECUTE FUNCTION public.touch_deleted_accounts();

-- 2. Profile soft-delete markers
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deletion_reason text;
CREATE INDEX IF NOT EXISTS profiles_deleted_at_idx ON public.profiles (deleted_at) WHERE deleted_at IS NOT NULL;

-- 3. Soft delete RPC
CREATE OR REPLACE FUNCTION public.admin_soft_delete_account(p_user_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_profile record;
  v_roles jsonb;
  v_register_id uuid;
BEGIN
  IF v_caller IS NULL OR NOT public.can_manage_deleted_accounts(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to delete accounts';
  END IF;
  IF p_user_id IS NULL OR p_user_id = v_caller THEN
    RAISE EXCEPTION 'Cannot delete your own account';
  END IF;
  IF coalesce(length(trim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found for %', p_user_id;
  END IF;
  IF v_profile.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Account is already deleted';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('role', role, 'enabled', enabled)), '[]'::jsonb)
    INTO v_roles FROM public.user_roles WHERE user_id = p_user_id;

  INSERT INTO public.deleted_accounts (
    user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by
  ) VALUES (
    p_user_id, v_profile.full_name, v_profile.email, v_profile.phone,
    v_profile.national_id, v_roles, 'soft_deleted', trim(p_reason), v_caller
  ) RETURNING id INTO v_register_id;

  DELETE FROM public.user_roles WHERE user_id = p_user_id;
  DELETE FROM public.push_subscriptions WHERE user_id = p_user_id;

  UPDATE public.profiles SET
    full_name = CASE WHEN full_name LIKE '[DELETED]%' THEN full_name ELSE '[DELETED] ' || coalesce(full_name, 'Account') END,
    previous_full_name = coalesce(previous_full_name, full_name),
    email = 'deleted+' || p_user_id::text || '@deleted.invalid',
    phone = NULL,
    national_id = NULL,
    mobile_money_number = NULL,
    is_frozen = true,
    frozen_at = coalesce(frozen_at, now()),
    frozen_reason = 'Account deleted: ' || trim(p_reason),
    deleted_at = now(),
    deleted_by = v_caller,
    deletion_reason = trim(p_reason)
  WHERE id = p_user_id;

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_caller, 'soft_delete_account', 'soft_delete_account', 'profiles', p_user_id::text,
    jsonb_build_object(
      'reason', trim(p_reason),
      'target_user_id', p_user_id,
      'performed_by', v_caller,
      'register_id', v_register_id,
      'before', jsonb_build_object('full_name', v_profile.full_name, 'email', v_profile.email, 'phone', v_profile.phone, 'national_id', v_profile.national_id),
      'roles', v_roles
    ));

  RETURN jsonb_build_object('success', true, 'register_id', v_register_id, 'user_id', p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_soft_delete_account(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_soft_delete_account(uuid, text) TO authenticated, service_role;

-- 4. Mark purged (called after a permanent delete)
CREATE OR REPLACE FUNCTION public.admin_mark_account_purged(p_user_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF coalesce(length(trim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  UPDATE public.deleted_accounts
     SET status = 'purged', purged_at = now(), purged_by = v_caller, purge_reason = trim(p_reason)
   WHERE user_id = p_user_id AND status = 'soft_deleted';

  IF NOT FOUND THEN
    INSERT INTO public.deleted_accounts (user_id, status, reason, deleted_by, purged_at, purged_by, purge_reason, metadata)
    VALUES (p_user_id, 'purged', trim(p_reason), v_caller, now(), v_caller, trim(p_reason),
            jsonb_build_object('note', 'purged without prior soft delete record'));
  END IF;

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_mark_account_purged(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_mark_account_purged(uuid, text) TO service_role;

-- 5. Restore RPC (only when the freed details are still available)
CREATE OR REPLACE FUNCTION public.admin_restore_soft_deleted_account(p_user_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_rec record;
  v_phone_taken boolean := false;
  v_nid_taken boolean := false;
BEGIN
  IF v_caller IS NULL OR NOT public.can_manage_deleted_accounts(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to restore accounts';
  END IF;
  IF coalesce(length(trim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_rec FROM public.deleted_accounts
   WHERE user_id = p_user_id AND status = 'soft_deleted'
   ORDER BY deleted_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No soft-deleted record found for %', p_user_id;
  END IF;

  IF v_rec.phone IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
       WHERE id <> p_user_id
         AND normalize_phone_last9(phone) = normalize_phone_last9(v_rec.phone)
    ) INTO v_phone_taken;
  END IF;
  IF v_rec.national_id IS NOT NULL AND v_rec.national_id <> '' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles WHERE id <> p_user_id AND national_id = v_rec.national_id
    ) INTO v_nid_taken;
  END IF;

  UPDATE public.profiles SET
    full_name = coalesce(nullif(v_rec.full_name, ''), full_name),
    email = coalesce(nullif(v_rec.email, ''), email),
    phone = CASE WHEN v_phone_taken THEN phone ELSE v_rec.phone END,
    national_id = CASE WHEN v_nid_taken THEN national_id ELSE v_rec.national_id END,
    is_frozen = false,
    frozen_at = NULL,
    frozen_reason = NULL,
    deleted_at = NULL,
    deleted_by = NULL,
    deletion_reason = NULL
  WHERE id = p_user_id;

  INSERT INTO public.user_roles (user_id, role, enabled)
  SELECT p_user_id, (r->>'role')::app_role, coalesce((r->>'enabled')::boolean, true)
    FROM jsonb_array_elements(v_rec.roles) r
  ON CONFLICT (user_id, role) DO NOTHING;

  UPDATE public.deleted_accounts
     SET status = 'restored', restored_at = now(), restored_by = v_caller, restore_reason = trim(p_reason)
   WHERE id = v_rec.id;

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_caller, 'restore_account', 'restore_account', 'profiles', p_user_id::text,
    jsonb_build_object('reason', trim(p_reason), 'target_user_id', p_user_id, 'performed_by', v_caller,
      'phone_restored', NOT v_phone_taken, 'national_id_restored', NOT v_nid_taken));

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id,
    'phone_restored', NOT v_phone_taken, 'national_id_restored', NOT v_nid_taken);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_restore_soft_deleted_account(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_restore_soft_deleted_account(uuid, text) TO authenticated, service_role;