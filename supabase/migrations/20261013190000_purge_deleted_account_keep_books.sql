-- CTO > Deleted Accounts > "Delete permanently" must work for accounts that have
-- money history.
--
-- Why a plain hard delete cannot be used for those accounts (verified on prod):
--   * general_ledger rejects UPDATE and DELETE (prevent_ledger_mutation), so a
--     ledger row can neither be removed nor have its user_id nulled.
--   * several finance tables hold NOT NULL references to profiles
--     (agent_advances.issued_by, investor_portfolios.agent_id,
--     angel_pool_investments.investor_id, agent_tid_backed_float.agent_id, ...);
--     admin_purge_user_dependencies() resolves those by DELETING the rows.
-- general_ledger.user_id has no foreign key, so the ledger is happy to outlive
-- the person; the profile row is what the finance tables point at.
--
-- So for an account with history, "permanent" means: erase the person, keep the
-- books. The profile row stays as an anonymous stub (so every finance FK holds),
-- every identity field is wiped, the login stays banned, the register entry is
-- stripped of PII and marked purged, and nothing in the ledger or any money table
-- is touched. Accounts with NO history still take the existing hard-delete path.
--
-- One refusal remains on purpose: a wallet that still holds a balance. That is
-- money owed to someone, not a record of the past, and erasing the owner would
-- strand it. Settle or move it first.

CREATE OR REPLACE FUNCTION public.admin_purge_deleted_account_keep_books(
  p_user_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_rec record;
  v_profile record;
  v_history jsonb;
  v_photo_paths text[];
  v_avatar_url text;
  v_audit_redacted integer := 0;
  v_notifications integer := 0;
  v_chats integer := 0;
BEGIN
  IF v_caller IS NULL OR NOT public.can_manage_deleted_accounts(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to permanently remove accounts';
  END IF;
  IF p_user_id IS NULL OR p_user_id = v_caller THEN
    RAISE EXCEPTION 'Cannot remove your own account';
  END IF;
  IF coalesce(length(trim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_rec
    FROM public.deleted_accounts
   WHERE user_id = p_user_id AND status = 'soft_deleted'
   ORDER BY deleted_at DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_SOFT_DELETED: delete the account first, then remove it permanently';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.wallets w
     WHERE w.user_id = p_user_id AND coalesce(w.balance, 0) <> 0
  ) THEN
    RAISE EXCEPTION 'WALLET_NOT_EMPTY: this account still holds a wallet balance. Settle or move the money first, then remove the account';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found for %', p_user_id;
  END IF;

  v_history := public.account_financial_history(p_user_id);
  v_photo_paths := array_remove(ARRAY[
    v_profile.national_id_photo_path,
    v_profile.selfie_photo_path,
    v_profile.national_id_back_photo_path
  ], NULL);
  v_avatar_url := v_profile.avatar_url;

  -- Pass 1: wipe identity. Changing full_name makes capture_previous_full_name
  -- copy the old (still personal) name into previous_full_name, hence pass 2.
  UPDATE public.profiles SET
    full_name = '[Deleted account]',
    email = 'deleted+' || p_user_id::text || '@deleted.invalid',
    phone = NULL,
    national_id = NULL,
    mobile_money_number = NULL,
    mobile_money_name = NULL,
    avatar_url = NULL,
    national_id_name = NULL,
    national_id_photo_path = NULL,
    selfie_photo_path = NULL,
    national_id_back_photo_path = NULL,
    selfie_image_hash = NULL,
    id_image_hash = NULL,
    date_of_birth = NULL,
    sex = NULL,
    national_id_card_number = NULL,
    national_id_surname = NULL,
    national_id_given_name = NULL,
    linked_national_id = NULL,
    signup_device_fp = NULL,
    residence_lat = NULL,
    residence_lng = NULL,
    landmark = NULL,
    village = NULL,
    parish = NULL,
    sub_county = NULL,
    district = NULL,
    town = NULL,
    city = NULL,
    region = NULL,
    ops_note = NULL,
    occupation = NULL,
    tenant_water_meter = NULL,
    tenant_electricity_meter = NULL,
    is_frozen = true,
    frozen_at = coalesce(frozen_at, now()),
    frozen_reason = 'Account permanently removed'
  WHERE id = p_user_id;

  -- Pass 2: name is unchanged now, so the trigger leaves this alone.
  UPDATE public.profiles SET previous_full_name = NULL WHERE id = p_user_id;

  -- log_profile_field_changes copied the old values of every field above into
  -- profile_field_audit (this update and the earlier soft delete). Keep the fact
  -- that a change happened, drop the personal values.
  UPDATE public.profile_field_audit
     SET old_value = NULL, new_value = NULL
   WHERE user_id = p_user_id
     AND (old_value IS NOT NULL OR new_value IS NOT NULL);
  GET DIAGNOSTICS v_audit_redacted = ROW_COUNT;

  -- Personal, non-financial satellites.
  DELETE FROM public.notifications WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_notifications = ROW_COUNT;
  DELETE FROM public.ai_chat_messages WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_chats = ROW_COUNT;
  DELETE FROM public.push_subscriptions WHERE user_id = p_user_id;
  DELETE FROM public.cart_items WHERE user_id = p_user_id;
  DELETE FROM public.user_roles WHERE user_id = p_user_id;

  -- Register entry: keep who/when/why, drop who the person was. The metadata also
  -- held the pre-delete login email and phone for the restore flow; restore is no
  -- longer possible, so those go too.
  UPDATE public.deleted_accounts SET
    full_name = NULL,
    email = NULL,
    phone = NULL,
    national_id = NULL,
    roles = '[]'::jsonb,
    metadata = jsonb_build_object(
      'erased', true,
      'erased_at', now(),
      'erased_keeping_financial_records', true
    ),
    status = 'purged',
    purged_at = now(),
    purged_by = v_caller,
    purge_reason = trim(p_reason)
  WHERE id = v_rec.id;

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_caller, 'purge_account_keep_books', 'purge_account_keep_books', 'profiles', p_user_id::text,
    jsonb_build_object(
      'reason', trim(p_reason),
      'target_user_id', p_user_id,
      'performed_by', v_caller,
      'register_id', v_rec.id,
      'financial_records_retained', v_history - 'has_history',
      'profile_audit_rows_redacted', v_audit_redacted,
      'notifications_deleted', v_notifications,
      'ai_chat_messages_deleted', v_chats,
      'identity_files_to_remove', coalesce(array_length(v_photo_paths, 1), 0)
    ));

  RETURN jsonb_build_object(
    'success', true,
    'user_id', p_user_id,
    'financial_records_retained', v_history - 'has_history',
    'identity_photo_paths', to_jsonb(v_photo_paths),
    'avatar_url', v_avatar_url
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_purge_deleted_account_keep_books(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_purge_deleted_account_keep_books(uuid, text) TO authenticated, service_role;
