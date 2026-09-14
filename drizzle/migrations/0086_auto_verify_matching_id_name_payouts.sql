-- When the name printed on the National ID matches the name on the payout
-- number/bank account, the destination verifies itself: no Financial Ops step,
-- and the account can withdraw from then on. Doubles, duplicate IDs and
-- unreadable ID names are never auto-verified.
CREATE OR REPLACE FUNCTION public.auto_verify_matching_payout_destinations(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_id_name text;
  v_has_photos boolean;
  v_double boolean := false;
  v_count integer := 0;
begin
  if p_user_id is null then
    return 0;
  end if;

  select nullif(btrim(coalesce(p.national_id_name, '')), ''),
         nullif(btrim(coalesce(p.national_id_photo_path, '')), '') is not null
           and nullif(btrim(coalesce(p.selfie_photo_path, '')), '') is not null
    into v_id_name, v_has_photos
    from public.profiles p
   where p.id = p_user_id;

  -- No readable ID name, or no archived photos: a human must still look.
  if v_id_name is null or length(v_id_name) < 5 or coalesce(v_has_photos, false) = false then
    return 0;
  end if;

  begin
    select coalesce((public.identity_double_submission(p_user_id)->>'is_double')::boolean, false)
      into v_double;
  exception when others then
    v_double := false;
  end;

  if v_double then
    return 0;
  end if;

  with matched as (
    update public.payout_destination_verifications d
       set status = 'verified',
           decided_at = now(),
           decided_by = null,
           decision_reason = 'Auto-verified: the name on the National ID matches the name on this payout account.',
           national_id_name = v_id_name,
           name_match_score = (public.payout_name_match_report(v_id_name, d.account_name)->>'score')::numeric,
           updated_at = now()
     where d.user_id = p_user_id
       and d.status <> 'verified'
       and coalesce((public.payout_name_match_report(v_id_name, d.account_name)->>'score')::numeric, 0) >= 0.9
    returning d.id, d.account_name
  )
  select count(*) into v_count from matched;

  if v_count > 0 then
    insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    values (p_user_id, 'payout_destination_auto_verified', 'payout_destination_verifications', p_user_id::text,
            'Name on the National ID matched the payout account name, so the destination was verified automatically.',
            jsonb_build_object('national_id_name', v_id_name, 'destinations_verified', v_count));
  end if;

  return v_count;
end;
$function$;

GRANT EXECUTE ON FUNCTION public.auto_verify_matching_payout_destinations(uuid) TO authenticated;

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
  v_auto integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'message', 'Please sign in again.');
  end if;

  -- One account, one National ID, one photo: a verified account is final.
  if public.identity_already_verified(v_uid) then
    return jsonb_build_object('success', false, 'already_verified', true,
      'message', 'Your identity is already verified. You do not need to send your National ID or selfie again.');
  end if;

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
             (select coalesce(nullif(btrim(coalesce(national_id_name,'')), '') , full_name) from public.profiles where id = v_uid),
             d.account_name)->>'score')::numeric,
         updated_at = now()
   where d.user_id = v_uid
     and d.status <> 'verified';

  -- Matching names verify themselves, so the person can withdraw right away.
  v_auto := public.auto_verify_matching_payout_destinations(v_uid);

  return jsonb_build_object(
    'success', true,
    'name_changed', v_name_changed,
    'auto_verified', v_auto,
    'full_name', case when v_name_changed then v_id_name else null end,
    'message', case
      when v_auto > 0 then 'Photos received. The name on your National ID matches your payout account, so you are verified and can withdraw now.'
      when v_name_changed then 'Photos received. Your account name now matches your National ID, and Financial Ops will verify you shortly.'
      else 'Photos received. Financial Ops will verify your identity.' end
  );
end;
$function$;