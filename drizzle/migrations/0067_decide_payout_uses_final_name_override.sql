CREATE OR REPLACE FUNCTION public.finops_decide_payout_destination(
  p_id uuid,
  p_decision text,
  p_reason text,
  p_call_outcome text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision,'')));
  v_reason text := btrim(coalesce(p_reason,''));
  v_row public.payout_destination_verifications;
  v_id_name text;
  v_old_name text;
  v_source text;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only Financial Ops can verify payout destinations.';
  END IF;
  IF v_decision NOT IN ('verified','rejected') THEN
    RAISE EXCEPTION 'Decision must be verified or rejected.';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Write at least 10 characters explaining the decision.';
  END IF;

  SELECT * INTO v_row FROM public.payout_destination_verifications WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Destination not found.';
  END IF;
  IF v_row.user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot verify your own payout destination.';
  END IF;

  UPDATE public.payout_destination_verifications
  SET status = v_decision,
      decision_reason = v_reason,
      call_outcome = nullif(btrim(coalesce(p_call_outcome,'')), ''),
      decided_by = v_uid,
      decided_at = now()
  WHERE id = p_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'payout_destination_' || v_decision, 'payout_destination_verifications', p_id::text, v_reason,
          jsonb_build_object('status', v_row.status),
          jsonb_build_object('status', v_decision, 'call_outcome', p_call_outcome, 'owner', v_row.user_id));

  -- On verification the confirmed name becomes the user's verified name.
  -- A manual Financial Ops override always wins over the OCR-read ID name.
  IF v_decision = 'verified' THEN
    v_id_name := btrim(coalesce(nullif(btrim(coalesce(v_row.final_name_override,'')), ''), v_row.national_id_name, ''));
    v_source := CASE WHEN nullif(btrim(coalesce(v_row.final_name_override,'')), '') IS NOT NULL
                     THEN 'financial_ops_manual_override' ELSE 'national_id_ocr' END;
    IF length(v_id_name) >= 3 THEN
      SELECT full_name INTO v_old_name FROM public.profiles WHERE id = v_row.user_id;
      IF v_old_name IS DISTINCT FROM v_id_name THEN
        UPDATE public.profiles SET full_name = v_id_name WHERE id = v_row.user_id;
        INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
        VALUES (v_uid, 'payout_holder_name_from_national_id', 'profiles', v_row.user_id::text,
                'Verified holder name applied during payout verification.',
                jsonb_build_object('full_name', v_old_name),
                jsonb_build_object('full_name', v_id_name, 'source', v_source));
      END IF;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('account_flagged', v_row.user_id,
            jsonb_build_object('kind', 'payout_destination_' || v_decision,
                               'destination_key', v_row.destination_key,
                               'decided_by', v_uid));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'status', v_decision);
END;
$$;
