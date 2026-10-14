-- A National ID that another account already holds no longer stops the user.
--
-- Before: submit_national_id / submit_national_id_details refused with "This
-- National ID is already recorded on another account", and Financial Ops could
-- never approve such an account (two auto-reject rules).
--
-- Now: the user's details are saved and the account is flagged for Financial Ops
-- review (profiles.national_id_review_conflict_with). The submitted ID is held as
-- linked_national_id, NOT profiles.national_id, so the one-ID-one-primary-account
-- unique indexes and identity_double_submission() are untouched. The user can
-- carry on to the withdrawal screen; the payout destination stays 'waiting'
-- until a HUMAN Financial Ops decision. Financial Ops may verify it with the
-- reason they already must write; that decision is audit-logged as an override.
--
-- Kept as is: the 20-accounts-per-ID cap still refuses outright, and a
-- double submission by phone number is still auto-rejected.
--
-- Safety net: every automatic verifier (queue sweep, name-match, rule sweep)
-- sets decided_by = NULL. A guard trigger refuses any such automatic
-- 'verified' while the account is flagged, so no sweep can approve a flagged
-- account without a person deciding.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS national_id_review_conflict_with uuid,
  ADD COLUMN IF NOT EXISTS national_id_review_requested_at timestamptz;

-- ---------------------------------------------------------------------------
-- Guard: no automatic 'verified' while the account is flagged for review.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_flagged_national_id_needs_human_verdict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'verified'
     AND NEW.decided_by IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'verified')
     AND EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = NEW.user_id
                    AND p.national_id_review_conflict_with IS NOT NULL) THEN
    IF TG_OP = 'INSERT' THEN
      NEW.status := 'waiting';
      NEW.decided_at := NULL;
    ELSE
      NEW.status := OLD.status;
      NEW.decided_at := OLD.decided_at;
      NEW.decision_reason := OLD.decision_reason;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_zz_guard_flagged_national_id_needs_human_verdict
  ON public.payout_destination_verifications;
CREATE TRIGGER trg_zz_guard_flagged_national_id_needs_human_verdict
  BEFORE INSERT OR UPDATE ON public.payout_destination_verifications
  FOR EACH ROW EXECUTE FUNCTION public.guard_flagged_national_id_needs_human_verdict();

-- ---------------------------------------------------------------------------
-- The duplicate-ID auto-reject trigger leaves flagged accounts for a person.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_reject_duplicate_national_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
BEGIN
  IF coalesce(btrim(NEW.national_id), '') = '' OR NEW.status = 'rejected' THEN
    RETURN NEW;
  END IF;

  -- Flagged for Financial Ops review: a person decides, not this trigger.
  IF EXISTS (SELECT 1 FROM public.profiles p
              WHERE p.id = NEW.user_id AND p.national_id_review_conflict_with IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  v_owner := public.duplicate_national_id_owner(NEW.user_id, NEW.national_id);
  IF v_owner IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.status := 'rejected';
  NEW.decision_reason := 'Automatically rejected: this National ID is already recorded on another account. One National ID may only be used by one account.';
  NEW.decided_at := now();

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (NEW.user_id, 'payout_destination_auto_rejected_duplicate_id',
            'payout_destination_verifications', NEW.id::text,
            'Automatic rejection: National ID already used on another account.',
            jsonb_build_object('national_id', NEW.national_id, 'duplicate_of_user_id', v_owner));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('account_flagged', NEW.user_id,
            jsonb_build_object('kind', 'duplicate_national_id', 'duplicate_of_user_id', v_owner));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Queue sweep: never auto-approve a flagged account.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finops_auto_approve_waiting_payout_destinations()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rules integer := 0;
  v_verified integer := 0;
  v_rejected integer := 0;
BEGIN
  BEGIN
    v_rules := public.auto_verify_waiting_payout_destinations(NULL);
  EXCEPTION WHEN others THEN
    RAISE WARNING 'finops_auto_approve: rule sweep failed: %', SQLERRM;
  END;

  WITH funders AS (
    SELECT DISTINCT ip.investor_id AS user_id
    FROM public.investor_portfolios ip
    WHERE lower(coalesce(ip.status, '')) NOT IN ('cancelled', 'rejected', 'deleted')
  ), queue AS (
    SELECT d.id, d.status, d.decision_reason, d.decided_by, d.decided_at
    FROM public.payout_destination_verifications d
    JOIN public.profiles p ON p.id = d.user_id
    LEFT JOIN funders f ON f.user_id = d.user_id
    LEFT JOIN public.mv_identity_double_users x ON x.user_id = d.user_id
    WHERE d.status = 'waiting'
      AND p.national_id_photo_path IS NOT NULL
      AND p.selfie_photo_path IS NOT NULL
      AND p.national_id_review_conflict_with IS NULL
      AND f.user_id IS NULL
      AND (x.user_id IS NULL
           OR EXISTS (
             SELECT 1 FROM public.national_id_link_requests r
             WHERE r.status IN ('owner_approved', 'active')
               AND ((r.requester_id = x.user_id AND r.holder_id = x.first_user_id)
                 OR (r.requester_id = x.first_user_id AND r.holder_id = x.user_id))))
    FOR UPDATE OF d SKIP LOCKED
  ), upd AS (
    UPDATE public.payout_destination_verifications d
       SET status = 'verified',
           decided_at = now(),
           decided_by = NULL,
           decision_reason = 'Auto-approved by the 10-minute Financial Ops queue sweep (handover doc 143).'
      FROM queue q
     WHERE d.id = q.id
    RETURNING d.id, d.user_id, d.status AS new_status, d.destination_key, d.account_name,
              q.status AS old_status, q.decision_reason AS old_reason,
              q.decided_by AS old_decided_by, q.decided_at AS old_decided_at
  ), aud AS (
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
    SELECT u.user_id, 'payout_destination_queue_auto_approved', 'payout_destination_verifications', u.id::text,
           'Financial Ops queue auto-approved by the 10-minute sweep (doc 143).',
           jsonb_build_object('status', u.old_status, 'decision_reason', u.old_reason,
                              'decided_by', u.old_decided_by, 'decided_at', u.old_decided_at),
           jsonb_build_object('status', u.new_status, 'destination_key', u.destination_key,
                              'account_name', u.account_name,
                              'source', 'finops_auto_approve_waiting_payout_destinations')
    FROM upd u
    RETURNING 1
  )
  SELECT count(*) FILTER (WHERE new_status = 'verified'),
         count(*) FILTER (WHERE new_status = 'rejected')
    INTO v_verified, v_rejected
  FROM upd;

  RETURN jsonb_build_object('rule_verified', v_rules,
                            'queue_verified', v_verified,
                            'duplicate_id_rejected', v_rejected);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Financial Ops decision: a person may verify a flagged account (override).
-- ---------------------------------------------------------------------------
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
  v_dbl jsonb;
  v_double boolean := false;
  v_name_match numeric;
  v_staff boolean;
  v_conflict_with uuid;
  v_override boolean := false;
BEGIN
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

  v_staff := v_uid IS NOT NULL AND (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  );
  IF NOT v_staff THEN
    RAISE EXCEPTION 'Only Financial Ops can verify payout destinations.';
  END IF;

  SELECT p.national_id_review_conflict_with INTO v_conflict_with
    FROM public.profiles p WHERE p.id = v_row.user_id;
  v_override := v_conflict_with IS NOT NULL;

  v_name_match := coalesce((public.payout_name_match_report(
      coalesce(nullif(btrim(coalesce(v_row.final_name_override,'')), ''), v_row.national_id_name),
      v_row.account_name)->>'score')::numeric, 0);

  v_dbl := public.identity_double_submission(v_row.user_id);
  IF v_decision = 'verified'
     AND coalesce((v_dbl ->> 'is_double')::boolean, false)
     AND NOT (v_override AND v_dbl ->> 'kind' = 'national_id') THEN
    v_double := true;
    v_decision := 'rejected';
    v_reason := 'Automatically rejected as a double submission: this '
                || CASE WHEN v_dbl ->> 'kind' = 'phone' THEN 'phone number' ELSE 'National ID' END
                || ' already verifies another account ('
                || coalesce(nullif(btrim(coalesce(v_dbl ->> 'first_name','')), ''), 'unnamed account')
                || '). Only the first account may use it.';
  END IF;

  -- A flagged account is one Financial Ops is deliberately reviewing: the
  -- duplicate-ID auto-reject does not apply to their own decision.
  IF NOT v_override THEN
    v_dup := public.duplicate_national_id_owner(v_row.user_id, v_row.national_id);
    IF v_dup IS NOT NULL AND v_decision = 'verified' THEN
      SELECT full_name INTO v_dup_name FROM public.profiles WHERE id = v_dup;
      v_decision := 'rejected';
      v_reason := 'Automatically rejected: this National ID is already recorded on another account ('
                  || coalesce(v_dup_name, 'unnamed account') || '). One National ID may only be used by one account.';
    END IF;
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
                             'duplicate_of_user_id', coalesce(v_dup, v_conflict_with),
                             'duplicate_id_override', v_override AND v_decision = 'verified',
                             'auto_rejected_double_submission', v_double,
                             'auto_rejected_unreadable_id_name', v_unreadable,
                             'double_submission', v_dbl,
                             'name_match_score', v_name_match,
                             'back_of_id_required', false,
                             'single_side_id_accepted', true));

  IF v_decision = 'verified' THEN
    IF v_override THEN
      UPDATE public.profiles
         SET national_id_review_conflict_with = NULL,
             national_id_review_requested_at = NULL
       WHERE id = v_row.user_id;
    END IF;

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

-- ---------------------------------------------------------------------------
-- submit_national_id (the single "Save my National ID" box).
-- Also fixes the same approved-link bug as 0553: an approved link is looked up
-- first, because duplicate_national_id_owner() skips the linked holder.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_national_id(p_national_id text, p_id_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_id text := upper(btrim(coalesce(p_national_id,'')));
  v_name text := btrim(coalesce(p_id_name,''));
  v_taken uuid;
  v_link uuid;
  v_hint jsonb;
  v_review boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'You must be signed in.');
  END IF;
  IF v_id !~ '^[A-Z0-9]{10,14}$' THEN
    RETURN jsonb_build_object('success', false, 'message', 'National ID number must be 10 to 14 letters and numbers, no spaces.');
  END IF;
  IF length(v_name) < 4 OR position(' ' IN v_name) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Enter your full name exactly as printed on the National ID.');
  END IF;

  SELECT id INTO v_link FROM public.national_id_link_requests
   WHERE requester_id = v_uid AND status IN ('owner_approved','active')
     AND nin_fuzzy = public.normalize_national_id_fuzzy(v_id)
   ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
   LIMIT 1;

  IF v_link IS NULL THEN
    v_taken := public.duplicate_national_id_owner(v_uid, v_id);
    IF v_taken IS NULL THEN
      SELECT id INTO v_taken FROM public.profiles
       WHERE upper(btrim(national_id)) = v_id AND id <> v_uid LIMIT 1;
    END IF;
  END IF;

  IF v_taken IS NOT NULL THEN
    v_hint := public.national_id_holder_hint(v_id);
    IF coalesce((v_hint->>'limit_reached')::boolean, false) THEN
      RETURN jsonb_build_object('success', false, 'duplicate', true, 'full', true,
        'message', 'This National ID has reached its limit of 20 accounts. No more accounts can be added to it.');
    END IF;
    v_review := true;
    UPDATE public.profiles
       SET linked_national_id = v_id,
           national_id_name = v_name,
           national_id_review_conflict_with = v_taken,
           national_id_review_requested_at = now()
     WHERE id = v_uid;
  ELSIF v_link IS NOT NULL THEN
    UPDATE public.profiles
       SET linked_national_id = v_id,
           linked_national_id_request_id = v_link,
           national_id_name = v_name
     WHERE id = v_uid;
  ELSE
    BEGIN
      UPDATE public.profiles
         SET national_id = v_id, national_id_name = v_name
       WHERE id = v_uid;
    EXCEPTION WHEN unique_violation THEN
      SELECT id INTO v_taken FROM public.profiles
       WHERE upper(btrim(national_id)) = v_id AND id <> v_uid LIMIT 1;
      v_review := true;
      UPDATE public.profiles
         SET linked_national_id = v_id,
             national_id_name = v_name,
             national_id_review_conflict_with = coalesce(v_taken, v_uid),
             national_id_review_requested_at = now()
       WHERE id = v_uid;
    END;
  END IF;

  -- A destination auto-rejected only because of the duplicate rule is reopened
  -- for the person who reviews it.
  UPDATE public.payout_destination_verifications d
  SET national_id = v_id,
      national_id_name = v_name,
      national_id_submitted_at = now(),
      name_match_score = (public.payout_name_match_report(v_name, d.account_name)->>'score')::numeric,
      name_mismatch_tokens = coalesce(public.payout_name_match_report(v_name, d.account_name)->'diff', '[]'::jsonb),
      status = CASE WHEN v_review AND d.status = 'rejected'
                         AND d.decision_reason ILIKE 'Automatically rejected: this National ID is already recorded%'
                    THEN 'waiting' ELSE d.status END,
      decision_reason = CASE WHEN v_review AND d.status = 'rejected'
                                  AND d.decision_reason ILIKE 'Automatically rejected: this National ID is already recorded%'
                             THEN 'Resubmitted after rejection: this National ID is held by another account, so Financial Ops review it.'
                             ELSE d.decision_reason END,
      decided_by = CASE WHEN v_review AND d.status = 'rejected'
                             AND d.decision_reason ILIKE 'Automatically rejected: this National ID is already recorded%'
                        THEN NULL ELSE d.decided_by END,
      decided_at = CASE WHEN v_review AND d.status = 'rejected'
                             AND d.decision_reason ILIKE 'Automatically rejected: this National ID is already recorded%'
                        THEN NULL ELSE d.decided_at END
  WHERE d.user_id = v_uid;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid,
          CASE WHEN v_review THEN 'national_id_submitted_pending_review' ELSE 'national_id_submitted' END,
          'profiles', v_uid::text,
          CASE WHEN v_review THEN 'User submitted a National ID already held by another account; flagged for Financial Ops review.'
               ELSE 'User submitted National ID for payout verification' END,
          jsonb_build_object('national_id', v_id, 'national_id_name', v_name,
                             'duplicate_of_user_id', v_taken, 'linked_group', v_link IS NOT NULL));

  IF v_review THEN
    BEGIN
      INSERT INTO public.system_events (event_type, user_id, metadata)
      VALUES ('account_flagged', v_uid,
              jsonb_build_object('kind', 'duplicate_national_id_pending_review', 'duplicate_of_user_id', v_taken));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN jsonb_build_object('success', true, 'pending_review', true,
      'message', 'National ID received. Financial Ops will review it and confirm your withdrawal number.');
  END IF;

  RETURN jsonb_build_object('success', true,
    'message', 'National ID recorded. Financial Ops will confirm it against your payout number.');
END;
$function$;

-- ---------------------------------------------------------------------------
-- submit_national_id_details (photo flow). Same rule: a held ID is saved and
-- flagged for review instead of refused; only the 20-account cap still refuses.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_national_id_details(p_surname text, p_given_name text, p_nin text, p_date_of_birth date, p_card_number text, p_sex text, p_reading jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_surname text := upper(btrim(coalesce(p_surname,'')));
  v_given   text := upper(btrim(coalesce(p_given_name,'')));
  v_nin     text := upper(regexp_replace(coalesce(p_nin,''), '[^A-Za-z0-9]', '', 'g'));
  v_card    text := regexp_replace(coalesce(p_card_number,''), '[^0-9]', '', 'g');
  v_sex     text := upper(btrim(coalesce(p_sex,'')));
  v_name    text;
  v_taken   uuid;
  v_link    uuid;
  v_linked  boolean := false;
  v_review  boolean := false;
  v_ocr     jsonb := coalesce(p_reading->'data', '{}'::jsonb);
  v_edited  text[] := '{}';
  v_reading_id uuid;
  v_hint    jsonb;
  v_twins   jsonb;
  v_name_key text;
  v_name_owner uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please sign in again.');
  END IF;

  IF v_surname !~ '^[A-Z][A-Z ''-]{1,39}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'surname',
      'message', 'Enter the surname exactly as printed on the card.');
  END IF;
  IF v_given !~ '^[A-Z][A-Z ''-]{1,39}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'given_name',
      'message', 'Enter the given name exactly as printed on the card.');
  END IF;
  IF v_nin !~ '^[A-Z0-9]{12,16}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'nin',
      'message', 'A NIN is 12 to 16 letters and numbers, with no spaces.');
  END IF;
  IF p_date_of_birth IS NULL
     OR p_date_of_birth > current_date
     OR extract(year FROM p_date_of_birth) < 1900 THEN
    RETURN jsonb_build_object('success', false, 'field', 'date_of_birth',
      'message', 'Enter the date of birth printed on the card.');
  END IF;
  IF v_card !~ '^[0-9]{6,12}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'card_number',
      'message', 'The card number is the row of digits on the card.');
  END IF;
  IF v_sex NOT IN ('M','F') THEN
    RETURN jsonb_build_object('success', false, 'field', 'sex',
      'message', 'Sex must be M or F, as printed on the card.');
  END IF;

  SELECT id INTO v_link FROM public.national_id_link_requests
   WHERE requester_id = v_uid AND status IN ('owner_approved','active')
     AND nin_fuzzy = public.normalize_national_id_fuzzy(v_nin)
   ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
   LIMIT 1;

  IF v_link IS NOT NULL THEN
    v_linked := true;
  ELSE
    SELECT public.duplicate_national_id_owner(v_uid, v_nin) INTO v_taken;
    IF v_taken IS NOT NULL THEN
      v_hint := public.national_id_holder_hint(v_nin);
      IF coalesce((v_hint->>'limit_reached')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'duplicate', true, 'full', true,
          'field', 'nin', 'accounts_on_id', v_hint->'accounts_on_id',
          'message', 'This National ID has reached its limit of 20 accounts. No more accounts can be added to it.');
      END IF;
      -- Held by another account and not linked: save as linked and flag it for
      -- Financial Ops instead of stopping the user here.
      v_linked := true;
      v_review := true;
    END IF;
  END IF;

  v_name := btrim(v_given || ' ' || v_surname);

  v_name_key := public.person_name_key(v_name);
  IF v_name_key IS NOT NULL AND position(' ' IN v_name_key) > 0 THEN
    SELECT p.id INTO v_name_owner
      FROM public.profiles p
     WHERE p.id IS DISTINCT FROM v_uid
       AND public.person_name_key(coalesce(nullif(btrim(p.national_id_name), ''), p.full_name)) = v_name_key
       AND public.normalize_national_id_fuzzy(coalesce(p.national_id, '')) IS DISTINCT FROM public.normalize_national_id_fuzzy(v_nin)
       AND nullif(btrim(coalesce(p.national_id, '')), '') IS NOT NULL
     ORDER BY p.created_at
     LIMIT 1;

    IF v_name_owner IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'field', 'surname', 'name_taken', true,
        'message', 'These names are already taken on another Welile account holding a different National ID. '
                || 'Please enter your own real names exactly as printed on your own card to continue.');
    END IF;
  END IF;

  IF coalesce(v_ocr->>'surname','')       IS DISTINCT FROM v_surname THEN v_edited := v_edited || 'surname'::text; END IF;
  IF coalesce(v_ocr->>'given_name','')    IS DISTINCT FROM v_given   THEN v_edited := v_edited || 'given_name'::text; END IF;
  IF coalesce(v_ocr->>'nin','')           IS DISTINCT FROM v_nin     THEN v_edited := v_edited || 'nin'::text; END IF;
  IF coalesce(v_ocr->>'date_of_birth','') IS DISTINCT FROM to_char(p_date_of_birth,'YYYY-MM-DD') THEN v_edited := v_edited || 'date_of_birth'::text; END IF;
  IF coalesce(v_ocr->>'card_number','')   IS DISTINCT FROM v_card    THEN v_edited := v_edited || 'card_number'::text; END IF;
  IF coalesce(v_ocr->>'sex','')           IS DISTINCT FROM v_sex     THEN v_edited := v_edited || 'sex'::text; END IF;

  BEGIN
    IF v_linked THEN
      UPDATE public.profiles
         SET linked_national_id       = v_nin,
             linked_national_id_request_id = v_link,
             national_id_name         = v_name,
             national_id_surname      = v_surname,
             national_id_given_name   = v_given,
             national_id_card_number  = v_card,
             date_of_birth            = p_date_of_birth,
             sex                      = v_sex,
             national_id_review_conflict_with = CASE WHEN v_review THEN v_taken ELSE national_id_review_conflict_with END,
             national_id_review_requested_at  = CASE WHEN v_review THEN now() ELSE national_id_review_requested_at END
       WHERE id = v_uid;
    ELSE
      UPDATE public.profiles
         SET national_id              = v_nin,
             national_id_name         = v_name,
             national_id_surname      = v_surname,
             national_id_given_name   = v_given,
             national_id_card_number  = v_card,
             date_of_birth            = p_date_of_birth,
             sex                      = v_sex
       WHERE id = v_uid;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- Race, or an exact-match holder the fuzzy owner check did not surface.
    v_hint := public.national_id_holder_hint(v_nin);
    IF coalesce((v_hint->>'limit_reached')::boolean, false) THEN
      RETURN jsonb_build_object('success', false, 'duplicate', true, 'full', true,
        'field', 'nin', 'accounts_on_id', v_hint->'accounts_on_id',
        'message', 'This National ID has reached its limit of 20 accounts. No more accounts can be added to it.');
    END IF;
    SELECT id INTO v_taken FROM public.profiles
     WHERE upper(btrim(national_id)) = v_nin AND id <> v_uid LIMIT 1;
    v_linked := true;
    v_review := true;
    UPDATE public.profiles
       SET linked_national_id       = v_nin,
           national_id_name         = v_name,
           national_id_surname      = v_surname,
           national_id_given_name   = v_given,
           national_id_card_number  = v_card,
           date_of_birth            = p_date_of_birth,
           sex                      = v_sex,
           national_id_review_conflict_with = coalesce(v_taken, v_uid),
           national_id_review_requested_at  = now()
     WHERE id = v_uid;
  END;

  UPDATE public.payout_destination_verifications d
     SET national_id = v_nin,
         national_id_name = v_name,
         national_id_submitted_at = now(),
         name_match_score = (public.payout_name_match_report(v_name, d.account_name)->>'score')::numeric,
         name_mismatch_tokens = coalesce(public.payout_name_match_report(v_name, d.account_name)->'diff', '[]'::jsonb),
         status = CASE WHEN v_review AND d.status = 'rejected'
                            AND d.decision_reason ILIKE 'Automatically rejected: this National ID is already recorded%'
                       THEN 'waiting' ELSE d.status END,
         decision_reason = CASE WHEN v_review AND d.status = 'rejected'
                                     AND d.decision_reason ILIKE 'Automatically rejected: this National ID is already recorded%'
                                THEN 'Resubmitted after rejection: this National ID is held by another account, so Financial Ops review it.'
                                ELSE d.decision_reason END,
         decided_by = CASE WHEN v_review AND d.status = 'rejected'
                                AND d.decision_reason ILIKE 'Automatically rejected: this National ID is already recorded%'
                           THEN NULL ELSE d.decided_by END,
         decided_at = CASE WHEN v_review AND d.status = 'rejected'
                                AND d.decision_reason ILIKE 'Automatically rejected: this National ID is already recorded%'
                           THEN NULL ELSE d.decided_at END
   WHERE d.user_id = v_uid;

  v_twins := public.national_id_name_twins(v_uid, v_name);

  INSERT INTO public.national_id_readings (
    user_id, sha256, status, confidence, ocr, field_verdicts, missing, consistency,
    confirmed, edited_fields, face_verified
  ) VALUES (
    v_uid,
    nullif(p_reading->>'sha256',''),
    nullif(p_reading->>'status',''),
    nullif(p_reading->>'confidence','')::numeric,
    v_ocr,
    coalesce(p_reading->'fields', '{}'::jsonb),
    coalesce((SELECT array_agg(x::text) FROM jsonb_array_elements_text(coalesce(p_reading->'missing','[]'::jsonb)) x), '{}'),
    coalesce(p_reading->'consistency', '[]'::jsonb),
    jsonb_build_object('surname', v_surname, 'given_name', v_given, 'nin', v_nin,
                       'date_of_birth', to_char(p_date_of_birth,'YYYY-MM-DD'),
                       'card_number', v_card, 'sex', v_sex),
    v_edited,
    CASE WHEN p_reading ? 'face_verified' THEN (p_reading->>'face_verified')::boolean END
  ) RETURNING id INTO v_reading_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'national_id_details_submitted', 'profiles', v_uid::text,
          CASE WHEN v_review
               THEN 'Account holder confirmed their National ID details; the ID is held by another account, so it is flagged for Financial Ops review.'
               ELSE 'Account holder confirmed the details read from their National ID.' END,
          jsonb_build_object('reading_id', v_reading_id,
                             'status', p_reading->>'status',
                             'linked_group', v_linked,
                             'pending_review', v_review,
                             'duplicate_of_user_id', v_taken,
                             'edited_fields', to_jsonb(v_edited),
                             'same_name_accounts', v_twins->'count',
                             'name_key', v_twins->>'name_key'));

  IF v_review THEN
    BEGIN
      INSERT INTO public.system_events (event_type, user_id, metadata)
      VALUES ('account_flagged', v_uid,
              jsonb_build_object('kind', 'duplicate_national_id_pending_review', 'duplicate_of_user_id', v_taken));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reading_id', v_reading_id,
    'linked', v_linked,
    'pending_review', v_review,
    'edited_fields', to_jsonb(v_edited),
    'full_name', v_name,
    'same_name_accounts', v_twins->'count',
    'message', CASE WHEN v_review
                    THEN 'National ID received. Financial Ops will review it and confirm your withdrawal number.'
                    ELSE 'National ID details saved.' END);
END;
$function$;
