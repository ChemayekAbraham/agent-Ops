-- Follow-up to 20260925170000 (handover doc 136), same day. Josh asked for the
-- second automatic rule to be wired in as well: payout_auto_verify_ready. It
-- verifies a destination when the number was confirmed by SMS code, the selfie
-- matches the National ID, and the ID number read off the photo equals the
-- typed one. It already existed live but nothing called it.
--
-- Doc 136 first called this rule unsafe, because the account name differs
-- from the ID name on all 8 rows it clears today. A closer look shows those
-- are ordinary MoMo lines registered in a relative's name, not payouts to
-- third parties:
--   * every one was confirmed by the SMS code sent to that exact destination;
--   * 7 of the 8 are the person's own login phone AND registered payout number;
--   * no other account uses any of the 8 numbers.
--
-- One gap is closed while wiring it in. payout_number_ownership_confirmed also
-- accepts ANY verified row in otp_verifications for the number, and that table
-- has no user_id, so the number's real owner signing up for their own account
-- would count as "this user owns it". Here ownership means only:
--   * ownership_code_confirmed_at is set on this destination row, or
--   * the number is the person's own login phone (profiles.phone).
--
-- This migration is self-contained and idempotent. It recreates everything
-- from 20260925170000 too, so it is correct whether or not that one applied
-- first.

DROP FUNCTION IF EXISTS public.payout_destination_auto_verdict(uuid, text, text);

CREATE OR REPLACE FUNCTION public.payout_destination_auto_verdict(
  p_user_id uuid,
  p_account_name text,
  p_national_id text,
  p_destination_type text,
  p_momo_number text,
  p_code_confirmed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id_name text;
  v_has_photos boolean;
  v_score numeric;
  v_login_phone text;
  v_face boolean;
  v_read_nin text;
  v_typed_nin text;
  v_norm text := '[^A-Za-z0-9]';
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT nullif(btrim(coalesce(p.national_id_name, '')), ''),
         nullif(btrim(coalesce(p.national_id_photo_path, '')), '') IS NOT NULL
           AND nullif(btrim(coalesce(p.selfie_photo_path, '')), '') IS NOT NULL,
         right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9)
    INTO v_id_name, v_has_photos, v_login_phone
  FROM public.profiles p WHERE p.id = p_user_id;

  -- Both rules need the ID photo and selfie on file.
  IF coalesce(v_has_photos, false) = false THEN
    RETURN NULL;
  END IF;

  BEGIN
    IF coalesce((public.identity_double_submission(p_user_id)->>'is_double')::boolean, false) THEN
      RETURN NULL;
    END IF;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  IF nullif(btrim(coalesce(p_national_id, '')), '') IS NOT NULL
     AND public.duplicate_national_id_owner(p_user_id, p_national_id) IS NOT NULL THEN
    RETURN NULL;
  END IF;

  -- Rule 1: the name on the National ID matches the name on the account.
  IF v_id_name IS NOT NULL AND length(v_id_name) >= 5 THEN
    v_score := coalesce((public.payout_name_match_report(v_id_name, p_account_name)->>'score')::numeric, 0);
    IF v_score >= 0.9 THEN
      RETURN jsonb_build_object(
        'rule', 'id_name_match',
        'score', v_score,
        'national_id_name', v_id_name,
        'reason', 'Auto-verified: the name on the National ID matches the name on this payout account.');
    END IF;
  END IF;

  -- Rule 2 (payout_auto_verify_ready): the number is proven to be theirs, the
  -- selfie matches the ID, and the ID number read off the photo equals the
  -- typed one. Ownership means the per-destination SMS code or their own login
  -- phone, NOT any verified OTP on the number (otp_verifications has no user_id).
  IF p_code_confirmed_at IS NOT NULL
     OR (p_destination_type = 'mobile_money'
         AND length(v_login_phone) = 9
         AND right(regexp_replace(coalesce(p_momo_number, ''), '\D', '', 'g'), 9) = v_login_phone) THEN
    SELECT r.face_verified,
           coalesce(nullif(btrim(coalesce(r.confirmed->>'nin', '')), ''), nullif(btrim(coalesce(r.ocr->>'nin', '')), ''))
      INTO v_face, v_read_nin
    FROM public.national_id_readings r
    WHERE r.user_id = p_user_id
    ORDER BY r.created_at DESC
    LIMIT 1;

    v_typed_nin := upper(regexp_replace(coalesce(p_national_id, ''), v_norm, '', 'g'));
    v_read_nin := upper(regexp_replace(coalesce(v_read_nin, ''), v_norm, '', 'g'));
    IF coalesce(v_face, false) AND v_typed_nin <> '' AND v_typed_nin = v_read_nin THEN
      RETURN jsonb_build_object(
        'rule', 'sms_code_face_nin',
        'reason', 'Auto-verified: the number was confirmed by SMS code, the selfie matched the National ID, and the ID number read from the photo matches.');
    END IF;
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.payout_destination_auto_verdict(uuid, text, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;

-- Single decision point: every write of a 'waiting' row is checked here.
CREATE OR REPLACE FUNCTION public.trg_auto_verify_payout_destination()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_verdict jsonb;
  v_old_name text;
  v_id_name text;
BEGIN
  IF NEW.status IS DISTINCT FROM 'waiting' THEN
    RETURN NEW;
  END IF;
  -- A person rejected this destination, so re-review stays with Financial Ops.
  IF TG_OP = 'UPDATE' AND OLD.status = 'rejected' THEN
    RETURN NEW;
  END IF;
  IF coalesce(NEW.decision_reason, '') ILIKE 'Resubmitted after rejection%' THEN
    RETURN NEW;
  END IF;

  -- Never let this check break ensure_payout_destination (and with it the
  -- withdrawal OTP). On any error the row simply stays 'waiting'.
  BEGIN
    v_verdict := public.payout_destination_auto_verdict(
      NEW.user_id, NEW.account_name, NEW.national_id,
      NEW.destination_type, NEW.momo_number, NEW.ownership_code_confirmed_at);

    IF v_verdict IS NULL THEN
      RETURN NEW;
    END IF;

    NEW.status := 'verified';
    NEW.decided_at := now();
    NEW.decided_by := NULL;
    NEW.decision_reason := v_verdict->>'reason';
    IF v_verdict ? 'score' THEN
      NEW.name_match_score := (v_verdict->>'score')::numeric;
      NEW.national_id_name := v_verdict->>'national_id_name';
    END IF;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
    VALUES (NEW.user_id, 'payout_destination_auto_verified', 'payout_destination_verifications',
            coalesce(NEW.id::text, NEW.user_id::text), v_verdict->>'reason',
            jsonb_build_object('status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END),
            jsonb_build_object('status', 'verified',
                               'rule', v_verdict->>'rule',
                               'name_match_score', v_verdict->'score',
                               'destination_key', NEW.destination_key,
                               'source', 'trg_auto_verify_payout_destination'));

    -- Rule 1 only, the same side effect as the existing name-match auto-verify
    -- and the Financial Ops decision: the account takes the exact name printed
    -- on the National ID.
    v_id_name := v_verdict->>'national_id_name';
    IF v_id_name IS NOT NULL THEN
      SELECT full_name INTO v_old_name FROM public.profiles WHERE id = NEW.user_id;
      IF coalesce(v_old_name, '') IS DISTINCT FROM v_id_name THEN
        UPDATE public.profiles SET full_name = v_id_name, updated_at = now() WHERE id = NEW.user_id;
        INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
        VALUES (NEW.user_id, 'payout_holder_name_from_national_id', 'profiles', NEW.user_id::text,
                'Auto-verification registered the account in the exact name printed on the National ID.',
                jsonb_build_object('full_name', v_old_name),
                jsonb_build_object('full_name', v_id_name, 'source', 'trg_auto_verify_payout_destination'));
      END IF;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'trg_auto_verify_payout_destination: % (destination %)', SQLERRM, NEW.id;
    -- NEW may be half-modified, so restore the waiting state explicitly.
    NEW.status := 'waiting';
    NEW.decided_at := CASE WHEN TG_OP = 'UPDATE' THEN OLD.decided_at ELSE NULL END;
    NEW.decided_by := CASE WHEN TG_OP = 'UPDATE' THEN OLD.decided_by ELSE NULL END;
    NEW.decision_reason := CASE WHEN TG_OP = 'UPDATE' THEN OLD.decision_reason ELSE NULL END;
    IF TG_OP = 'UPDATE' THEN
      NEW.name_match_score := OLD.name_match_score;
      NEW.national_id_name := OLD.national_id_name;
    END IF;
  END;

  RETURN NEW;
END;
$function$;

-- "trg_zz_" sorts after trg_auto_reject_duplicate_national_id, so a duplicate
-- National ID is rejected first and this trigger then sees status 'rejected'.
DROP TRIGGER IF EXISTS trg_zz_auto_verify_payout_destination ON public.payout_destination_verifications;
CREATE TRIGGER trg_zz_auto_verify_payout_destination
  BEFORE INSERT OR UPDATE ON public.payout_destination_verifications
  FOR EACH ROW EXECUTE FUNCTION public.trg_auto_verify_payout_destination();

-- Re-check waiting rows for all users, or for one. Only rows that will pass
-- are touched, so updated_at on the rest of the queue is left alone.
CREATE OR REPLACE FUNCTION public.auto_verify_waiting_payout_destinations(p_user_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  WITH hit AS (
    UPDATE public.payout_destination_verifications d
       SET updated_at = now()
     WHERE d.status = 'waiting'
       AND (p_user_id IS NULL OR d.user_id = p_user_id)
       AND coalesce(d.decision_reason, '') NOT ILIKE 'Resubmitted after rejection%'
       AND public.payout_destination_auto_verdict(
             d.user_id, d.account_name, d.national_id,
             d.destination_type, d.momo_number, d.ownership_code_confirmed_at) IS NOT NULL
    RETURNING d.status
  )
  SELECT count(*) FILTER (WHERE status = 'verified') INTO v_count FROM hit;
  RETURN coalesce(v_count, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_verify_waiting_payout_destinations(uuid) FROM PUBLIC, anon, authenticated;

-- "Check again" on the withdraw screen re-runs the check for the signed-in
-- person only.
CREATE OR REPLACE FUNCTION public.recheck_my_payout_destinations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN 0;
  END IF;
  RETURN public.auto_verify_waiting_payout_destinations(auth.uid());
END;
$function$;

REVOKE ALL ON FUNCTION public.recheck_my_payout_destinations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recheck_my_payout_destinations() TO authenticated;

-- Evidence that arrives later: the ID name, photos or number on the profile, or
-- a new ID reading (face match / ID number read) for rule 2.
CREATE OR REPLACE FUNCTION public.trg_recheck_payout_destinations_for_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public.auto_verify_waiting_payout_destinations(
      CASE WHEN TG_TABLE_NAME = 'profiles' THEN NEW.id ELSE NEW.user_id END);
  EXCEPTION WHEN others THEN
    RAISE WARNING 'trg_recheck_payout_destinations_for_user: %', SQLERRM;
  END;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_recheck_payout_destinations_on_id ON public.profiles;
CREATE TRIGGER trg_recheck_payout_destinations_on_id
  AFTER UPDATE OF national_id_name, national_id_photo_path, selfie_photo_path, national_id ON public.profiles
  FOR EACH ROW
  WHEN (OLD.national_id_name IS DISTINCT FROM NEW.national_id_name
        OR OLD.national_id_photo_path IS DISTINCT FROM NEW.national_id_photo_path
        OR OLD.selfie_photo_path IS DISTINCT FROM NEW.selfie_photo_path
        OR OLD.national_id IS DISTINCT FROM NEW.national_id)
  EXECUTE FUNCTION public.trg_recheck_payout_destinations_for_user();

DROP TRIGGER IF EXISTS trg_recheck_payout_destinations_on_reading ON public.national_id_readings;
CREATE TRIGGER trg_recheck_payout_destinations_on_reading
  AFTER INSERT OR UPDATE ON public.national_id_readings
  FOR EACH ROW EXECUTE FUNCTION public.trg_recheck_payout_destinations_for_user();

-- Backstop sweep for anything the triggers above do not see.
DO $$
BEGIN
  PERFORM cron.unschedule('auto-verify-waiting-payout-destinations')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-verify-waiting-payout-destinations');
END $$;

SELECT cron.schedule(
  'auto-verify-waiting-payout-destinations',
  '*/10 * * * *',
  $$SELECT public.auto_verify_waiting_payout_destinations(NULL)$$
);

-- Clear what already qualifies: 4 by name match and 8 by SMS code + face + ID
-- number (live dry run, 2026-09-25).
SELECT public.auto_verify_waiting_payout_destinations(NULL);
