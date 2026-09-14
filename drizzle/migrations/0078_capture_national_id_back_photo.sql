-- Store the back side of the National ID alongside the front.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS national_id_back_photo_path text;

-- Accept the back-side photo. Third argument is optional so any older client
-- keeps working, and both sides are recorded in the same submission/audit entry.
CREATE OR REPLACE FUNCTION public.submit_identity_photos(
  p_id_photo_path text,
  p_selfie_path text,
  p_id_back_photo_path text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_recent_count integer;
  v_back text := nullif(btrim(coalesce(p_id_back_photo_path,'')), '');
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'message', 'Please sign in again.');
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
         identity_photos_submitted_at = now()
   where id = v_uid;

  insert into public.audit_logs (action_type, table_name, record_id, user_id, reason, new_values)
  values ('identity_photos_submitted', 'profiles', v_uid, v_uid,
          'User submitted National ID photos (front and back) and selfie for payout identity verification',
          jsonb_build_object('national_id_photo_path', btrim(p_id_photo_path),
                             'national_id_back_photo_path', v_back,
                             'selfie_photo_path', btrim(p_selfie_path)));

  return jsonb_build_object('success', true, 'message', 'Photos received. Financial Ops will verify your identity.');
end;
$function$;