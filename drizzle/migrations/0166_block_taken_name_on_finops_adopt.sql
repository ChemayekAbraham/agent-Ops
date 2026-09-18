-- Financial Ops may not move a name onto an account when those exact names
-- already belong to another account holding a different National ID. Same rule
-- the person's own submission now follows.
CREATE OR REPLACE FUNCTION public.finops_adopt_national_id_name(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.payout_destination_verifications;
  v_old_name text;
  v_new_name text;
  v_reason text := btrim(coalesce(p_reason, 'Adopted the name printed on the National ID after a name mismatch.'));
  v_name_key text;
  v_clash uuid;
  v_clash_name text;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only Financial Ops can change a holder name from the National ID.';
  END IF;

  SELECT * INTO v_row FROM public.payout_destination_verifications WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Destination not found.';
  END IF;

  v_new_name := btrim(coalesce(v_row.national_id_name, ''));
  IF length(v_new_name) < 3 THEN
    RAISE EXCEPTION 'No readable name was captured from the National ID.';
  END IF;

  v_name_key := public.person_name_key(v_new_name);
  IF v_name_key IS NOT NULL AND position(' ' IN v_name_key) > 0 THEN
    SELECT p.id, coalesce(nullif(btrim(p.national_id_name), ''), p.full_name)
      INTO v_clash, v_clash_name
      FROM public.profiles p
     WHERE p.id IS DISTINCT FROM v_row.user_id
       AND public.person_name_key(coalesce(nullif(btrim(p.national_id_name), ''), p.full_name)) = v_name_key
       AND nullif(btrim(coalesce(p.national_id, '')), '') IS NOT NULL
       AND public.normalize_national_id_fuzzy(coalesce(p.national_id, ''))
           IS DISTINCT FROM public.normalize_national_id_fuzzy(coalesce(v_row.national_id, ''))
     ORDER BY p.created_at
     LIMIT 1;

    IF v_clash IS NOT NULL THEN
      RAISE EXCEPTION 'That name is already taken by another account holding a different National ID. Ask this person to submit their own real names.';
    END IF;
  END IF;

  SELECT full_name INTO v_old_name FROM public.profiles WHERE id = v_row.user_id;

  UPDATE public.profiles SET full_name = v_new_name, updated_at = now() WHERE id = v_row.user_id;

  IF length(v_reason) < 10 THEN
    v_reason := 'Adopted the name printed on the National ID after a name mismatch.';
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'payout_holder_name_from_national_id', 'profiles', v_row.user_id::text, v_reason,
          jsonb_build_object('full_name', v_old_name),
          jsonb_build_object('full_name', v_new_name, 'source', 'national_id_ocr', 'destination_id', p_id));

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('account_flagged', v_row.user_id,
            jsonb_build_object('kind', 'holder_name_from_national_id',
                               'old_name', v_old_name,
                               'new_name', v_new_name,
                               'decided_by', v_uid));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'full_name', v_new_name);
END;
$function$;
