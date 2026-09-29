-- CEO concern 2026-09-29: "If the login phone can be changed by just an SMS OTP
-- to the new number, withdraw verification has no help."
--
-- Two holes closed here (see docs/HANDOVER/162):
--
-- 1. profiles.phone was directly writable by the account owner. RLS policy
--    "Users can update own profile" + column UPDATE grant to `authenticated`
--    meant supabase.from('profiles').update({ phone }) worked with NO OTP at all
--    -- the self-update-phone edge function was advisory, not enforced. This
--    trigger makes that edge function (service role, auth.uid() IS NULL) the
--    only way a user can swap an already-set phone. Staff editing OTHER users
--    (auth.uid() <> NEW.id) and first-time set (OLD.phone empty) are untouched.
--
-- 2. The edge function only proved control of the NEW number. It now also
--    requires a one-time code sent to the CURRENT number. This table holds
--    those challenges (same pattern as wallet_withdrawal_otp_challenges: hash
--    only, RLS on with zero policies, service_role access only).

CREATE OR REPLACE FUNCTION public.trg_block_self_service_phone_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
    RETURN NEW;
  END IF;
  -- service role / cron / edge function with admin client
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  -- staff / managing agent editing someone else's profile: existing behaviour
  IF auth.uid() <> NEW.id THEN
    RETURN NEW;
  END IF;
  -- first-ever phone on the profile
  IF nullif(btrim(coalesce(OLD.phone, '')), '') IS NULL THEN
    RETURN NEW;
  END IF;
  -- pure reformatting of the same number (0783.. -> +256783..)
  IF public.normalize_phone_last9(OLD.phone) IS NOT DISTINCT FROM public.normalize_phone_last9(NEW.phone) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'phone_change_requires_verification: change your login phone from Settings (code to your current number is required)'
    USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS trg_block_self_service_phone_change ON public.profiles;
CREATE TRIGGER trg_block_self_service_phone_change
  BEFORE UPDATE OF phone ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.trg_block_self_service_phone_change();

CREATE TABLE IF NOT EXISTS public.phone_change_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- Snapshot of the CURRENT phone the code was sent to, and the last 9 digits
  -- of the phone the user wants to move to (the code only unlocks that move).
  old_phone text NOT NULL,
  new_phone_last9 text NOT NULL,
  otp_hash text NOT NULL,
  otp_expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired', 'failed')),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phone_change_otp_challenges_user
  ON public.phone_change_otp_challenges (user_id, created_at DESC);

ALTER TABLE public.phone_change_otp_challenges ENABLE ROW LEVEL SECURITY;
