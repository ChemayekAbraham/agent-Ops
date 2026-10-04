-- Let the Verify Payouts button decide any user's payout destination,
-- including a case where the row happens to belong to the signed-in
-- Financial Ops / CFO / super_admin reviewer. Previously this raised
-- "You cannot verify your own payout destination." and blocked the row
-- entirely — there was no way for anyone to action it.
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
  v_back text;
  v_dbl jsonb;
  v_double boolean := false;
  v_name_match numeric;
  v_back_cutoff constant timestamptz := timestamptz '2026-09-14 14:00:00+00';
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

  v_name_match := coalesce((public.payout_name_match_report(
      coalesce(nullif(btrim(coalesce(v_row.final_name_override,'')), ''), v_row.national_id_name),
      v_row.account_name)->>'score')::numeric, 0);

  -- Back-of-ID is only demanded when the names do not match.
  IF v_decision = 'verified'
     AND v_name_match < 0.9
     AND coalesce(v_row.national_id_submitted_at, v_row.first_seen_at) >= v_back_cutoff THEN
    SELECT nullif(btrim(coalesce(national_id_back_photo_path,'')), '') INTO v_back
    FROM public.profiles WHERE id = v_row.user_id;
    IF v_back IS NULL THEN
      RAISE EXCEPTION 'Cannot verify — the back of the National ID is missing. Ask the user to upload a photo of the back of their National ID.';
    END IF;
  END IF;

  -- Double submission: one National ID and one phone number verify one account only.
  v_dbl := public.identity_double_submission(v_row.user_id);
  IF v_decision = 'verified' AND coalesce((v_dbl ->> 'is_double')::boolean, false) THEN
    v_double := true;
    v_decision := 'rejected';
    v_reason := 'Automatically rejected as a double submission: this '
                || CASE WHEN v_dbl ->> 'kind' = 'phone' THEN 'phone number' ELSE 'National ID' END
                || ' already verifies another account ('
                || coalesce(nullif(btrim(coalesce(v_dbl ->> 'first_name','')), ''), 'unnamed account')
                || '). Only the first account may use it.';
  END IF;

  v_dup := public.duplicate_national_id_owner(v_row.user_id, v_row.national_id);
  IF v_dup IS NOT NULL AND v_decision = 'verified' THEN
    SELECT full_name INTO v_dup_name FROM public.profiles WHERE id = v_dup;
    v_decision := 'rejected';
    v_reason := 'Automatically rejected: this National ID is already recorded on another account ('
                || coalesce(v_dup_name, 'unnamed account') || '). One National ID may only be used by one account.';
  END IF;

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
                             'auto_rejected_double_submission', v_double,
                             'auto_rejected_unreadable_id_name', v_unreadable,
                             'double_submission', v_dbl,
                             'name_match_score', v_name_match,
                             'single_side_id_accepted', (v_name_match >= 0.9),
                             'self_verified', (v_row.user_id = v_uid)));

  IF v_decision = 'verified' THEN
    SELECT full_name INTO v_old_name FROM public.profiles WHERE id = v_row.user_id;
    IF v_id_name IS NOT NULL AND length(v_id_name) >= 3 AND coalesce(v_old_name,'') IS DISTINCT FROM v_id_name THEN
      UPDATE public.profiles SET full_name = v_id_name, updated_at = now() WHERE id = v_row.user_id;
      v_source := CASE WHEN nullif(btrim(coalesce(v_row.final_name_override,'')), '') IS NOT NULL
                       THEN 'final_name_override' ELSE 'national_id_name' END;
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
      VALUES (v_uid, 'payout_holder_name_from_national_id', 'profiles', v_row.user_id::text,
              'Account name replaced with the exact name read on the verified National ID.',
              jsonb_build_object('full_name', v_old_name),
              jsonb_build_object('full_name', v_id_name, 'source', v_source));
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'status', v_decision, 'reason', v_reason);
END;
$function$;
