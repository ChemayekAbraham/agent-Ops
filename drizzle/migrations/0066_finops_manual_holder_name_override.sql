ALTER TABLE public.payout_destination_verifications
  ADD COLUMN IF NOT EXISTS final_name_override text,
  ADD COLUMN IF NOT EXISTS final_name_override_by uuid,
  ADD COLUMN IF NOT EXISTS final_name_override_at timestamptz;

-- Financial Ops types or confirms the final holder name before verifying.
CREATE OR REPLACE FUNCTION public.finops_set_holder_name(
  p_id uuid,
  p_full_name text,
  p_reason text DEFAULT NULL,
  p_apply_now boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.payout_destination_verifications;
  v_name text := btrim(coalesce(p_full_name, ''));
  v_old_name text;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only Financial Ops can set a payout holder name.';
  END IF;

  IF length(v_name) < 3 THEN
    RAISE EXCEPTION 'Write the full name as printed on the National ID (at least 3 characters).';
  END IF;
  IF v_name !~ '^[A-Za-z][A-Za-z''\-\. ]{2,79}$' THEN
    RAISE EXCEPTION 'Use letters, spaces, apostrophes, hyphens and full stops only.';
  END IF;

  SELECT * INTO v_row FROM public.payout_destination_verifications WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Destination not found.';
  END IF;

  IF length(v_reason) < 10 THEN
    v_reason := 'Financial Ops confirmed the final holder name after a name mismatch review.';
  END IF;

  UPDATE public.payout_destination_verifications
  SET final_name_override = v_name,
      final_name_override_by = v_uid,
      final_name_override_at = now()
  WHERE id = p_id;

  SELECT full_name INTO v_old_name FROM public.profiles WHERE id = v_row.user_id;

  IF p_apply_now AND v_old_name IS DISTINCT FROM v_name THEN
    UPDATE public.profiles SET full_name = v_name, updated_at = now() WHERE id = v_row.user_id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'payout_holder_name_manual_override', 'profiles', v_row.user_id::text, v_reason,
          jsonb_build_object('full_name', v_old_name),
          jsonb_build_object('full_name', v_name,
                             'source', 'financial_ops_manual_override',
                             'applied_now', p_apply_now,
                             'national_id_name', v_row.national_id_name,
                             'destination_id', p_id));

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('account_flagged', v_row.user_id,
            jsonb_build_object('kind', 'holder_name_manual_override',
                               'old_name', v_old_name,
                               'new_name', v_name,
                               'decided_by', v_uid));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'full_name', v_name);
END;
$$;

GRANT EXECUTE ON FUNCTION public.finops_set_holder_name(uuid, text, text, boolean) TO authenticated;
