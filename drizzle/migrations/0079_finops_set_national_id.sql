-- Financial Ops corrects the National ID number on a payout verification.
-- Re-reading the ID photo gives a fresh name, which is adopted as the account
-- name in the same call, so no extra action is needed.
CREATE OR REPLACE FUNCTION public.finops_set_national_id(
  p_id uuid,
  p_national_id text,
  p_national_id_name text DEFAULT NULL,
  p_name_match_score numeric DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_dest public.payout_destination_verifications;
  v_id text := regexp_replace(upper(coalesce(p_national_id,'')), '[^A-Z0-9]', '', 'g');
  v_name text := nullif(btrim(coalesce(p_national_id_name,'')), '');
  v_dup uuid;
  v_old_name text;
  v_adopted boolean := false;
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
  IF length(v_id) < 6 THEN
    RETURN jsonb_build_object('success', false, 'message', 'A National ID needs at least 6 letters or numbers.');
  END IF;

  v_dup := public.duplicate_national_id_owner(v_dest.user_id, v_id);
  IF v_dup IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'duplicate', true,
      'duplicate_of_name', (SELECT full_name FROM public.profiles WHERE id = v_dup),
      'message', 'Duplicate National ID rejected — this ID already belongs to another account.');
  END IF;

  SELECT full_name INTO v_old_name FROM public.profiles WHERE id = v_dest.user_id;

  BEGIN
    UPDATE public.payout_destination_verifications
       SET national_id = v_id,
           national_id_name = coalesce(v_name, national_id_name),
           name_match_score = coalesce(p_name_match_score, name_match_score),
           national_id_submitted_at = now()
     WHERE id = p_id;

    UPDATE public.profiles
       SET national_id = v_id,
           national_id_name = coalesce(v_name, national_id_name)
     WHERE id = v_dest.user_id;

    -- The name read off the ID becomes the account name straight away.
    IF v_name IS NOT NULL AND length(v_name) >= 3
       AND lower(coalesce(v_old_name,'')) <> lower(v_name) THEN
      UPDATE public.profiles SET full_name = v_name WHERE id = v_dest.user_id;
      v_adopted := true;

      INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, old_values, new_values)
      VALUES ('payout_holder_name_from_national_id', 'profiles', v_dest.user_id, v_uid,
              'Account name updated from the National ID after Financial Ops edited the ID number',
              jsonb_build_object('full_name', v_old_name),
              jsonb_build_object('full_name', v_name, 'national_id', v_id, 'source', 'national_id_ocr'));
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'success', false,
      'duplicate', true,
      'message', 'Duplicate National ID rejected — this ID already belongs to another account.');
  END;

  RETURN jsonb_build_object(
    'success', true,
    'national_id', v_id,
    'national_id_name', v_name,
    'name_adopted', v_adopted,
    'full_name', coalesce(CASE WHEN v_adopted THEN v_name END, v_old_name));
END;
$function$;

REVOKE ALL ON FUNCTION public.finops_set_national_id(uuid, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finops_set_national_id(uuid, text, text, numeric) TO authenticated;