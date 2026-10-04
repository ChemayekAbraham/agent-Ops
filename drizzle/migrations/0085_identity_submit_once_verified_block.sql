-- Once an account has been verified by Financial Ops, its National ID and
-- selfie are final: one account, one National ID, one photo. Further
-- submissions are refused so a verified person cannot re-enter the queue.
CREATE OR REPLACE FUNCTION public.identity_already_verified(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.payout_destination_verifications d
    WHERE d.user_id = p_user_id
      AND d.status = 'verified'
  ) AND EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_user_id
      AND nullif(btrim(coalesce(p.national_id_photo_path, '')), '') IS NOT NULL
      AND nullif(btrim(coalesce(p.selfie_photo_path, '')), '') IS NOT NULL
  );
$$;

GRANT EXECUTE ON FUNCTION public.identity_already_verified(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_identity_photos(p_id_photo_path text, p_selfie_path text, p_id_back_photo_path text, p_name_change_consent boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_recent_count integer;
  v_back text := nullif(btrim(coalesce(p_id_back_photo_path,'')), '');
  v_consent boolean := coalesce(p_name_change_consent, false);
  v_id_name text;
  v_old_name text;
  v_name_changed boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'message', 'Please sign in again.');
  end if;

  -- One account, one National ID, one photo: a verified account is final.
  if public.identity_already_verified(v_uid) then
    return jsonb_build_object('success', false, 'already_verified', true,
      'message', 'Your identity is already verified. You do not need to send your National ID or selfie again.');
  end if;

  -- Weekly submission cap: at most 3 ID+selfie submissions in any rolling 7 days
  select count(*) into v_recent_count
    from public.audit_logs
   where action_type = 'identity_photos_submitted'
     and user_id = v_uid
     and created_at > now() - interval '7 days';

  if v_recent_count >= 3 then
    return jsonb_build_object('success', false,
      'message', 'You have reached the limit of 3 identity submissions this week. Please try again later or contact support if your photos keep being rejected.');
  end if;

  if coalesce(btrim(p_id_photo_path),'') = '' or coalesce(btrim(p_selfie_path),'') = '' then
    return jsonb_build_object('success', false, 'message', 'Both the National ID photo and the selfie are required.');
  end if;
  if split_part(p_id_photo_path, '/', 1) <> v_uid::text or split_part(p_selfie_path, '/', 1) <> v_uid::text then
    return jsonb_build_object('success', false, 'message', 'Those photos do not belong to your account.');
  end if;
  if v_back is not null and split_part(v_back, '/', 1) <> v_uid::text then
    return jsonb_build_object('success', false, 'message', 'Those photos do not belong to your account.');
  end if;

  update public.profiles
     set national_id_photo_path = btrim(p_id_photo_path),
         selfie_photo_path = btrim(p_selfie_path),
         national_id_back_photo_path = coalesce(v_back, national_id_back_photo_path),
         identity_photos_submitted_at = now(),
         id_name_change_consent_at = case when v_consent then now() else id_name_change_consent_at end
   where id = v_uid;

  insert into public.audit_logs (action_type, table_name, record_id, user_id, reason, new_values)
  values ('identity_photos_submitted', 'profiles', v_uid, v_uid,
          'User submitted National ID photos and selfie for payout identity verification',
          jsonb_build_object('national_id_photo_path', btrim(p_id_photo_path),
                             'national_id_back_photo_path', v_back,
                             'selfie_photo_path', btrim(p_selfie_path),
                             'name_change_consent', v_consent));

  if v_consent then
    select nullif(btrim(coalesce(national_id_name,'')), ''), full_name
      into v_id_name, v_old_name
      from public.profiles where id = v_uid;

    if v_id_name is not null and length(v_id_name) >= 3
       and coalesce(v_old_name,'') is distinct from v_id_name then
      update public.profiles set full_name = v_id_name, updated_at = now() where id = v_uid;
      v_name_changed := true;

      insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
      values (v_uid, 'payout_holder_name_from_national_id', 'profiles', v_uid::text,
              'Account holder agreed that the exact name on their National ID becomes their account name.',
              jsonb_build_object('full_name', v_old_name),
              jsonb_build_object('full_name', v_id_name, 'source', 'user_consent_on_submission'));
    end if;
  end if;

  -- Every fresh submission goes back into the Financial Ops waiting queue,
  -- except rows already verified, which stay verified.
  update public.payout_destination_verifications d
     set status = 'waiting',
         decision_reason = case
           when d.status = 'waiting' then d.decision_reason
           else 'New National ID and selfie submitted — waiting for Financial Ops to verify.'
         end,
         decided_by = case when d.status = 'waiting' then d.decided_by else null end,
         decided_at = case when d.status = 'waiting' then d.decided_at else null end,
         national_id_submitted_at = now(),
         national_id = coalesce((select national_id from public.profiles where id = v_uid), d.national_id),
         national_id_name = coalesce((select nullif(btrim(coalesce(national_id_name,'')), '') from public.profiles where id = v_uid), d.national_id_name),
         name_match_score = (public.payout_name_match_report(
             (select coalesce(nullif(btrim(coalesce(national_id_name,'')), ''), full_name) from public.profiles where id = v_uid),
             d.account_name)->>'score')::numeric,
         updated_at = now()
   where d.user_id = v_uid
     and d.status <> 'verified';

  return jsonb_build_object(
    'success', true,
    'name_changed', v_name_changed,
    'full_name', case when v_name_changed then v_id_name else null end,
    'message', case when v_name_changed
      then 'Photos received. Your account name now matches your National ID, and Financial Ops will verify you shortly.'
      else 'Photos received. Financial Ops will verify your identity.' end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_identity_photos(p_id_photo_path text, p_selfie_path text, p_id_back_photo_path text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return public.submit_identity_photos(p_id_photo_path, p_selfie_path, p_id_back_photo_path, false);
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_identity_photos(p_id_photo_path text, p_selfie_path text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return public.submit_identity_photos(p_id_photo_path, p_selfie_path, null::text, false);
end;
$function$;