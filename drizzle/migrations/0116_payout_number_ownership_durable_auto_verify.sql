-- Two defects in the payout auto-verification path:
--
-- 1. Ownership by SMS code was only ever inferred from `otp_verifications`,
--    which is short-lived (rows are purged/replaced). Once the row was gone
--    the reviewer's panel said "No code on file" even though the holder had
--    confirmed the number, and automatic verification could never fire.
--    Fixed by stamping the confirmation on the destination row itself.
--
-- 2. Automatic verification only ran inside a reviewer's browser, so a holder
--    who passed every machine check sat at "waiting" until Financial Ops
--    happened to open their case. Fixed by letting the holder's own confirmed
--    code run the very same guarded decision function, and only when every
--    machine check passes server-side.

ALTER TABLE public.payout_destination_verifications
  ADD COLUMN IF NOT EXISTS ownership_code_confirmed_at timestamptz;

COMMENT ON COLUMN public.payout_destination_verifications.ownership_code_confirmed_at IS
  'When the holder proved ownership of this payout number with the SMS code sent to it. Durable record; otp_verifications rows are purged.';

-- Durable yes/no, no role gate (internal helper).
CREATE OR REPLACE FUNCTION public.payout_number_ownership_confirmed(p_destination_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type text;
  v_number text;
  v_stamped timestamptz;
  v_key text;
BEGIN
  SELECT d.destination_type, d.momo_number, d.ownership_code_confirmed_at
    INTO v_type, v_number, v_stamped
  FROM public.payout_destination_verifications d
  WHERE d.id = p_destination_id;

  IF v_stamped IS NOT NULL THEN
    RETURN true;
  END IF;
  IF v_type IS NULL OR v_type <> 'mobile_money' THEN
    RETURN false;
  END IF;

  v_key := right(regexp_replace(coalesce(v_number, ''), '\D', '', 'g'), 9);
  IF length(v_key) <> 9 THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.otp_verifications o
    WHERE o.phone = v_key AND o.verified = true AND o.verified_at IS NOT NULL
  );
END;
$$;

-- Reviewer-facing wrapper keeps its role gate.
CREATE OR REPLACE FUNCTION public.finops_payout_number_ownership_confirmed(p_destination_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only Financial Ops can read payout number ownership.';
  END IF;
  RETURN public.payout_number_ownership_confirmed(p_destination_id);
END;
$$;

-- Every machine check the reviewer panel makes, evaluated server-side.
CREATE OR REPLACE FUNCTION public.payout_auto_verify_ready(p_destination_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.payout_destination_verifications;
  v_face boolean;
  v_read_nin text;
  v_typed_nin text;
  v_id_photo text;
  v_selfie text;
  v_norm text := '[^A-Za-z0-9]';
BEGIN
  SELECT * INTO v_row FROM public.payout_destination_verifications WHERE id = p_destination_id;
  IF v_row.id IS NULL OR v_row.status <> 'waiting' THEN
    RETURN false;
  END IF;

  IF NOT public.payout_number_ownership_confirmed(p_destination_id) THEN
    RETURN false;
  END IF;

  SELECT nullif(btrim(coalesce(p.national_id_photo_path, '')), ''),
         nullif(btrim(coalesce(p.selfie_photo_path, '')), '')
    INTO v_id_photo, v_selfie
  FROM public.profiles p WHERE p.id = v_row.user_id;
  IF v_id_photo IS NULL OR v_selfie IS NULL THEN
    RETURN false;
  END IF;

  SELECT r.face_verified,
         coalesce(nullif(btrim(coalesce(r.confirmed->>'nin', '')), ''), nullif(btrim(coalesce(r.ocr->>'nin', '')), ''))
    INTO v_face, v_read_nin
  FROM public.national_id_readings r
  WHERE r.user_id = v_row.user_id
  ORDER BY r.created_at DESC
  LIMIT 1;

  IF coalesce(v_face, false) IS NOT TRUE THEN
    RETURN false;
  END IF;

  v_typed_nin := upper(regexp_replace(coalesce(v_row.national_id, ''), v_norm, '', 'g'));
  v_read_nin := upper(regexp_replace(coalesce(v_read_nin, ''), v_norm, '', 'g'));
  IF v_typed_nin = '' OR v_read_nin = '' OR v_typed_nin <> v_read_nin THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

-- The holder stamps ownership after their own code verified, then the same
-- guarded decision function runs. No new decision logic lives here.
CREATE OR REPLACE FUNCTION public.confirm_payout_number_ownership(p_number text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := right(regexp_replace(coalesce(p_number, ''), '\D', '', 'g'), 9);
  v_ok boolean;
  v_id uuid;
  v_auto boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.';
  END IF;
  IF length(v_key) <> 9 THEN
    RAISE EXCEPTION 'That does not look like a mobile money number.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.otp_verifications o
    WHERE o.phone = v_key AND o.verified = true AND o.verified_at IS NOT NULL
      AND o.verified_at > now() - interval '24 hours'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Confirm the code sent to that number first.';
  END IF;

  UPDATE public.payout_destination_verifications d
  SET ownership_code_confirmed_at = coalesce(d.ownership_code_confirmed_at, now())
  WHERE d.user_id = v_uid
    AND d.destination_type = 'mobile_money'
    AND right(regexp_replace(coalesce(d.momo_number, ''), '\D', '', 'g'), 9) = v_key;

  SELECT d.id INTO v_id
  FROM public.payout_destination_verifications d
  WHERE d.user_id = v_uid
    AND d.destination_type = 'mobile_money'
    AND right(regexp_replace(coalesce(d.momo_number, ''), '\D', '', 'g'), 9) = v_key
    AND d.status = 'waiting'
  ORDER BY d.updated_at DESC NULLS LAST
  LIMIT 1;

  IF v_id IS NOT NULL AND public.payout_auto_verify_ready(v_id) THEN
    PERFORM public.finops_decide_payout_destination(
      v_id, 'verified',
      'Automatically verified: the ID number read off the card matches the number given, the selfie passed the face check, and this payout number was confirmed with the code sent to it.',
      'sms_ownership_code');
    v_auto := true;
  END IF;

  RETURN jsonb_build_object('success', true, 'auto_verified', v_auto);
END;
$$;

GRANT EXECUTE ON FUNCTION public.payout_number_ownership_confirmed(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.payout_auto_verify_ready(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payout_number_ownership(text) TO authenticated;
