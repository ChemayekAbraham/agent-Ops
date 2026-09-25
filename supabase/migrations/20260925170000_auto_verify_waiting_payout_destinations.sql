-- "Waiting on Financial Ops phone verification should be automatic." (Josh, 2026-09-25)
--
-- Live state before this migration: 2,819 payout destinations in 'waiting',
-- and zero auto-verifications since 2026-09-24 13:40 UTC. Two automatic
-- verification rules already existed, but neither was actually wired in:
--
--   1. auto_verify_matching_payout_destinations (National ID name matches the
--      account name, score >= 0.9, ID photo + selfie on file, not a double
--      submission). Its ONLY caller is submit_identity_photos. A number added
--      AFTER the person's ID was captured is inserted as 'waiting' by
--      ensure_payout_destination and is never checked again, so it sits in the
--      Financial Ops call queue even when the names match.
--   2. payout_auto_verify_ready (number proven by SMS code + face matched +
--      NIN read off the ID equals the typed NIN). Nothing calls it, and it is
--      deliberately NOT wired in here: it proves who the account holder is,
--      not that the number is theirs. Dry-run on live data it would have
--      verified 8 rows, e.g. "Aguti Elizabeth" on Priscilla Lolem's ID and
--      "Yaseen Sebunya" / "Tenywa vicent" on Shafeeq Ssenabulya's ID, i.e.
--      payouts to third parties' numbers.
--
-- This migration makes rule 1 run by itself:
--   * BEFORE INSERT/UPDATE trigger on payout_destination_verifications decides
--     any 'waiting' row the moment it is written, so ensure_payout_destination's
--     RETURNING already says 'verified' and the withdrawal proceeds on the same
--     attempt. ensure_payout_destination itself is untouched (it is watched by
--     critical_function_baselines).
--   * Profile ID field changes and a 10-minute cron
--     sweep re-check waiting rows, so evidence that arrives later clears them.
--   * recheck_my_payout_destinations() lets the withdraw screen's "Check again"
--     button re-run the check for the signed-in person.
--
-- Deliberately NOT automatic (stay with Financial Ops):
--   * rows a human rejected (and their "resubmitted after rejection" state),
--   * double submissions / a National ID already on another account,
--   * names that do not match the National ID (third-party / relative numbers:
--     the owner can still clear those instantly with the SMS consent code),
--   * people with no ID photo + selfie. That is ~2,500 of the waiting rows.
--     There is no evidence to verify them on.

CREATE OR REPLACE FUNCTION public.payout_destination_auto_verdict(
  p_user_id uuid,
  p_account_name text,
  p_national_id text
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
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT nullif(btrim(coalesce(p.national_id_name, '')), ''),
         nullif(btrim(coalesce(p.national_id_photo_path, '')), '') IS NOT NULL
           AND nullif(btrim(coalesce(p.selfie_photo_path, '')), '') IS NOT NULL
    INTO v_id_name, v_has_photos
  FROM public.profiles p WHERE p.id = p_user_id;

  -- The ID photo and selfie must be on file (same as the existing rule).
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

  -- The name on the National ID matches the name on the account.
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

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.payout_destination_auto_verdict(uuid, text, text) FROM PUBLIC, anon, authenticated;

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
  -- A human rejected this destination: re-review stays with Financial Ops.
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
      NEW.user_id, NEW.account_name, NEW.national_id);

    IF v_verdict IS NULL THEN
      RETURN NEW;
    END IF;

    NEW.status := 'verified';
    NEW.decided_at := now();
    NEW.decided_by := NULL;
    NEW.decision_reason := v_verdict->>'reason';
    NEW.name_match_score := (v_verdict->>'score')::numeric;
    NEW.national_id_name := v_verdict->>'national_id_name';

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
    VALUES (NEW.user_id, 'payout_destination_auto_verified', 'payout_destination_verifications',
            coalesce(NEW.id::text, NEW.user_id::text), v_verdict->>'reason',
            jsonb_build_object('status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END),
            jsonb_build_object('status', 'verified',
                               'name_match_score', v_verdict->'score',
                               'destination_key', NEW.destination_key,
                               'source', 'trg_auto_verify_payout_destination'));

    -- Same side effect as the existing name-match auto-verify and the Ops
    -- decision: the account takes the exact name printed on the National ID.
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
    -- NEW may be half-modified; restore the waiting state explicitly.
    NEW.status := 'waiting';
    NEW.decided_at := CASE WHEN TG_OP = 'UPDATE' THEN OLD.decided_at ELSE NULL END;
    NEW.decided_by := CASE WHEN TG_OP = 'UPDATE' THEN OLD.decided_by ELSE NULL END;
    NEW.decision_reason := CASE WHEN TG_OP = 'UPDATE' THEN OLD.decision_reason ELSE NULL END;
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

-- Re-check waiting rows (all users, or one). Only rows that will pass are
-- touched, so updated_at on the rest of the queue is left alone.
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
             d.user_id, d.account_name, d.national_id) IS NOT NULL
    RETURNING d.status
  )
  SELECT count(*) FILTER (WHERE status = 'verified') INTO v_count FROM hit;
  RETURN coalesce(v_count, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_verify_waiting_payout_destinations(uuid) FROM PUBLIC, anon, authenticated;

-- "Check again" on the withdraw screen: re-run for the signed-in person only.
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

-- Evidence arriving later: ID name / photos / number on the profile.
CREATE OR REPLACE FUNCTION public.trg_recheck_payout_destinations_for_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public.auto_verify_waiting_payout_destinations(NEW.id);
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

-- Clear what already qualifies.
SELECT public.auto_verify_waiting_payout_destinations(NULL);
