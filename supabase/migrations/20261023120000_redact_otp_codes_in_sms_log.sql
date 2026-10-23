-- Remove one-time codes already written into `sms_delivery_log`.
--
-- Every OTP sender except issue-landlord-payout-otp wrote the live code into
-- this table. Measured 2026-10-23: 2,115 rows in the previous 30 days carried a
-- real code, 134 of them in the previous 24 hours — wallet_withdrawal_otp
-- (1,267), password-reset-sms (282), rent_renewal_otp (165), device-step-up
-- (123), the cash-deposit senders (118) and phone_change_old_number_otp (44).
--
-- The table is readable by manager / cfo / ceo / coo / cto / super_admin — 65
-- people — and its restrictive staff-MFA policy is a no-op while
-- staff_mfa_config.mode is 'shadow', so a password-only staff session is enough
-- to read a code that is still valid and use it to authorise a withdrawal,
-- complete a password reset, or clear a new-device step-up.
--
-- Senders stopped writing codes in the same change as this migration
-- (_shared/redactSmsCodes.ts). This clears what is already stored.
--
-- Only the digits change. The wording stays, so the audit trail, the character
-- count and the segment count all remain correct. Amounts ("UGX 1,000,000"),
-- masked tails ("ending 9270", "***573") and phone numbers are left alone
-- because the patterns only fire in a code context.

CREATE OR REPLACE FUNCTION public.redact_sms_codes(p_message text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
DECLARE
  v_out text := p_message;
  v_m   text[];
  -- "code: 123456" / "OTP 123456" / "PIN 1234" — digits follow the word.
  v_after  text := '((?:code|OTP|PIN)[[:space:]]*[:#]?[[:space:]]*)([0-9]{4,8})\M';
  -- "123456 is your code" — digits lead.
  v_before text := '\m([0-9]{4,8})([[:space:]]+is your[[:space:]]+(?:code|OTP|PIN))';
BEGIN
  IF v_out IS NULL THEN RETURN NULL; END IF;

  -- Each pass turns digits into stars, so the pattern cannot match the same
  -- spot twice and the loop always terminates.
  LOOP
    v_m := regexp_match(v_out, v_after, 'i');
    EXIT WHEN v_m IS NULL;
    v_out := regexp_replace(v_out, v_after, v_m[1] || repeat('*', length(v_m[2])), 'i');
  END LOOP;

  LOOP
    v_m := regexp_match(v_out, v_before, 'i');
    EXIT WHEN v_m IS NULL;
    v_out := regexp_replace(v_out, v_before, repeat('*', length(v_m[1])) || v_m[2], 'i');
  END LOOP;

  RETURN v_out;
END
$fn$;

COMMENT ON FUNCTION public.redact_sms_codes(text) IS
  'Masks one-time codes in an SMS body, preserving wording, length and segment count. Mirrors supabase/functions/_shared/redactSmsCodes.ts.';

-- Scrub what is already stored. Guarded to rows the function actually changes,
-- so untouched rows are not rewritten and updated_at-style triggers (if any are
-- added later) stay quiet. Verified before running against one real sample per
-- source: codes masked; amounts (UGX 20,000,000), masked tails ("ending 9270",
-- "***457") and the support number (0748747134) all unchanged; message length
-- identical on every row.
UPDATE public.sms_delivery_log
   SET message = public.redact_sms_codes(message)
 WHERE message IS NOT NULL
   AND public.redact_sms_codes(message) IS DISTINCT FROM message;
