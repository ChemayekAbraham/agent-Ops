-- Read-only helper: did the payout number itself pass an SMS ownership code?
--
-- The identity screen sends a 6-digit code to the payout number and only saves
-- the number after that code verifies (IdentityPhotoCapture -> sms-otp ->
-- set_withdrawal_account). The proof lives in otp_verifications, keyed on the
-- last 9 digits of the phone, which is deliberately unreadable by clients.
--
-- This exposes ONLY a boolean, to payout reviewers only, so the Financial Ops
-- queue can auto-verify a destination whose National ID number, selfie face
-- check and phone-ownership code all passed. It writes nothing and changes no
-- verification rule: the decision still runs through
-- finops_decide_payout_destination with all of its own guards intact.
CREATE OR REPLACE FUNCTION public.finops_payout_number_ownership_confirmed(p_destination_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_type text;
  v_number text;
  v_key text;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only Financial Ops can read payout number ownership.';
  END IF;

  SELECT d.destination_type, d.momo_number
    INTO v_type, v_number
  FROM public.payout_destination_verifications d
  WHERE d.id = p_destination_id;

  IF v_type IS NULL OR v_type <> 'mobile_money' THEN
    RETURN false;
  END IF;

  v_key := right(regexp_replace(coalesce(v_number, ''), '\D', '', 'g'), 9);
  IF length(v_key) <> 9 THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.otp_verifications o
    WHERE o.phone = v_key
      AND o.verified = true
      AND o.verified_at IS NOT NULL
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.finops_payout_number_ownership_confirmed(uuid) TO authenticated;