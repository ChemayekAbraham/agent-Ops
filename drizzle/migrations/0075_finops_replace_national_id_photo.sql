CREATE OR REPLACE FUNCTION public.finops_replace_national_id_photo(p_id uuid, p_photo_path text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_dest public.payout_destination_verifications;
  v_path text := nullif(btrim(coalesce(p_photo_path,'')), '');
  v_old text;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;

  SELECT * INTO v_dest FROM public.payout_destination_verifications WHERE id = p_id;
  IF v_dest.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'That payout record no longer exists.');
  END IF;
  IF v_dest.user_id = v_uid THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot edit your own verification.');
  END IF;
  IF v_path IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'No photo was uploaded.');
  END IF;
  IF v_path NOT LIKE (v_dest.user_id::text || '/%') THEN
    RETURN jsonb_build_object('success', false, 'message', 'That photo does not belong to this person.');
  END IF;

  SELECT national_id_photo_path INTO v_old FROM public.profiles WHERE id = v_dest.user_id;

  UPDATE public.profiles
     SET national_id_photo_path = v_path,
         identity_photos_submitted_at = now()
   WHERE id = v_dest.user_id;

  UPDATE public.payout_destination_verifications
     SET national_id_submitted_at = now()
   WHERE id = p_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, old_values, new_values)
  VALUES ('payout_national_id_photo_replaced', 'profiles', v_dest.user_id, v_uid,
          'Financial Ops replaced the National ID photo because no name could be read from the previous one',
          jsonb_build_object('national_id_photo_path', v_old),
          jsonb_build_object('national_id_photo_path', v_path));

  RETURN jsonb_build_object('success', true, 'national_id_photo_path', v_path);
END;
$function$;