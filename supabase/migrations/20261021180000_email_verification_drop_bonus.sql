-- Drop the UGX 100 verified-email reward. Nobody is credited.
--
-- Decision (Josh, 2026-10-21): paying for an email is not needed. The value
-- was never the 100 shillings — it was making profiles.email mean something.
-- A dialog that keeps returning until the user supplies a working address
-- achieves that without putting cash behind it, and without the farming
-- surface a per-user bounty creates.
--
-- What stays: the whole ownership-proof flow. A 6-digit code is mailed to the
-- address, and profiles.email moves only once that code comes back. That was
-- always the real fix — before it, EmailEditor wrote the column before the
-- confirmation link was clicked, so it recorded a claim rather than a fact.
--
-- What goes:
--   * the ledger post, so no money moves and nothing touches a wallet;
--   * email_verification_bonus_go_live(), which existed only to exclude new
--     signups from the reward;
--   * the per-user advisory lock, which existed only to serialise crediting;
--   * uq_evc_one_bonus_per_user and the three bonus columns.
--
-- bonus_skipped_reason becomes failure_reason, which the flow still uses to
-- record why a challenge died (send_failed, email_taken).
--
-- Safe to run: email_verification_challenges holds 0 rows, and no
-- 'email_verification_bonus:%' leg was ever posted to general_ledger (both
-- verified 2026-10-21 before applying).

ALTER TABLE public.email_verification_challenges
  DROP CONSTRAINT IF EXISTS email_verification_challenges_new_email_shape;

DROP INDEX IF EXISTS public.uq_evc_one_bonus_per_user;

ALTER TABLE public.email_verification_challenges
  RENAME COLUMN bonus_skipped_reason TO failure_reason;

ALTER TABLE public.email_verification_challenges
  DROP COLUMN IF EXISTS bonus_credited_at,
  DROP COLUMN IF EXISTS old_email_eligible;

ALTER TABLE public.email_verification_challenges
  ADD CONSTRAINT email_verification_challenges_new_email_shape
  CHECK (position('@' IN new_email) > 1 AND new_email = lower(btrim(new_email)));

DROP FUNCTION IF EXISTS public.email_verification_bonus_go_live();

COMMENT ON TABLE public.email_verification_challenges IS
  'Email ownership challenges. A row proves a 6-digit code was mailed to new_email and, once verified_at is set, that the owner read it. No money is attached. Written only by the email-verify-request / email-verify-confirm edge functions.';

-- ---------------------------------------------------------------------------
-- Verify the code and adopt the address. Nothing else.
-- Service-role only (closed by default, doc 247 step 23).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_email_verification(
  p_challenge_id uuid,
  p_user_id      uuid,
  p_code_hash    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ch  email_verification_challenges%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_ch FROM email_verification_challenges
   WHERE id = p_challenge_id FOR UPDATE;

  -- A missing row and a row belonging to somebody else are the same answer,
  -- so a leaked challenge id reveals nothing.
  IF NOT FOUND OR v_ch.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('status','error','reason','challenge_not_found');
  END IF;
  IF v_ch.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('status','error','reason','already_used');
  END IF;
  IF v_ch.expires_at <= v_now THEN
    RETURN jsonb_build_object('status','error','reason','expired');
  END IF;
  IF v_ch.attempts >= v_ch.max_attempts THEN
    RETURN jsonb_build_object('status','error','reason','too_many_attempts');
  END IF;

  IF p_code_hash IS NULL OR p_code_hash IS DISTINCT FROM v_ch.code_hash THEN
    UPDATE email_verification_challenges SET attempts = attempts + 1 WHERE id = v_ch.id;
    RETURN jsonb_build_object(
      'status','error','reason','wrong_code',
      'attempts_left', GREATEST(v_ch.max_attempts - (v_ch.attempts + 1), 0)
    );
  END IF;

  -- One live account per address.
  IF EXISTS (
    SELECT 1 FROM profiles
     WHERE lower(btrim(email)) = v_ch.new_email AND id <> v_ch.user_id
  ) THEN
    UPDATE email_verification_challenges
       SET consumed_at = v_now, failure_reason = 'email_taken'
     WHERE id = v_ch.id;
    RETURN jsonb_build_object('status','error','reason','email_taken');
  END IF;

  UPDATE profiles SET email = v_ch.new_email WHERE id = v_ch.user_id;
  UPDATE email_verification_challenges
     SET verified_at = COALESCE(verified_at, v_now), consumed_at = v_now
   WHERE id = v_ch.id;

  RETURN jsonb_build_object('status','verified','email',v_ch.new_email);
END;
$fn$;

COMMENT ON FUNCTION public.confirm_email_verification(uuid, uuid, text) IS
  'Verifies an emailed code and adopts the address onto profiles.email. No money is involved. Service-role only.';
