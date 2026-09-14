CREATE OR REPLACE FUNCTION public.finops_decide_payout_destination(p_id uuid, p_decision text, p_reason text, p_call_outcome text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision,'')));
  v_reason text := btrim(coalesce(p_reason,''));
  v_row public.payout_destination_verifications;
  v_id_name text;
  v_old_name text;
  v_source text;
  v_dup uuid;
  v_dup_name text;
  v_unreadable boolean := false;
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

  -- Same National ID on another account: forced rejection, whatever was tapped.
  v_dup := public.duplicate_national_id_owner(v_row.user_id, v_row.national_id);
  IF v_dup IS NOT NULL AND v_decision = 'verified' THEN
    SELECT full_name INTO v_dup_name FROM public.profiles WHERE id = v_dup;
    v_decision := 'rejected';
    v_reason := 'Automatically rejected: this National ID is already recorded on another account ('
                || coalesce(v_dup_name, 'unnamed account') || '). One National ID may only be used by one account.';
  END IF;

  -- Unreadable National ID name: forced rejection when trying to verify.
  IF v_decision = 'verified' THEN
    v_id_name := btrim(coalesce(nullif(btrim(coalesce(v_row.final_name_override,'')), ''), v_row.national_id_name, ''));
    IF length(v_id_name) < 3 THEN
      v_unreadable := true;
      v_decision := 'rejected';
      v_reason := 'Automatically rejected: no name could be read on the National ID photo. Ask the user to submit a clearer photo of their National ID.';
    END IF;
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
          jsonb_build_object('status', v_decision, 'call_outcome', p_call_outcome, 'owner', v_row.user_id,
                             'duplicate_of_user_id', v_dup,
                             'auto_rejected_unreadable_id_name', v_unreadable));

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

  RETURN jsonb_build_object(
    'success', true,
    'status', v_decision,
    'auto_rejected_duplicate_id', v_dup IS NOT NULL,
    'auto_rejected_unreadable_id_name', v_unreadable,
    'duplicate_of_name', v_dup_name,
    'full_name', CASE WHEN v_decision = 'verified' AND length(coalesce(v_id_name,'')) >= 3 THEN v_id_name ELSE NULL END,
    'name_source', CASE WHEN v_decision = 'verified' AND length(coalesce(v_id_name,'')) >= 3
                        THEN CASE WHEN v_source = 'financial_ops_manual_override' THEN 'verified' ELSE 'national_id' END
                        ELSE NULL END
  );
END;
$function$;