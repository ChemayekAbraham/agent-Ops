-- Withdrawals stay open while Financial Ops has not yet decided, provided the
-- person has actually submitted their identity (active binding with a locked
-- payout number) and that number is the one being paid. A rejected destination
-- still blocks; a missing submission still blocks.
CREATE OR REPLACE FUNCTION public.withdrawal_destination_gate(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w public.withdrawal_requests;
  m text;
  v_dest_status text;
  v_binding record;
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  m := lower(coalesce(w.payout_method, ''));
  IF m NOT IN ('mobile_money','bank_transfer') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'method_not_gated');
  END IF;

  IF w.landlord_payout_id IS NOT NULL
     OR coalesce(w.reason,'') LIKE 'Landlord float payout%' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'landlord_payout');
  END IF;

  IF public.withdrawal_verification_exempt(p_withdrawal_id) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'legacy_pending_cutoff');
  END IF;

  IF w.proxy_partner_id IS NOT NULL
     AND w.initiated_by IS NOT NULL
     AND w.initiated_by <> w.user_id THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'proxy_initiated');
  END IF;

  IF public.user_is_pure_partner(w.user_id) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'partner_exempt');
  END IF;

  IF public.payout_destination_is_verified(
       w.user_id, w.payout_method, w.mobile_money_number, w.bank_name, w.bank_account_number) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'verified');
  END IF;

  -- A Financial Ops rejection on this destination is a hard stop.
  SELECT d.status INTO v_dest_status
  FROM public.payout_destination_verifications d
  WHERE d.user_id = w.user_id
    AND d.destination_key = public.payout_destination_key(
          w.payout_method, w.mobile_money_number, w.bank_name, w.bank_account_number)
  ORDER BY (d.status = 'rejected') DESC, d.updated_at DESC NULLS LAST
  LIMIT 1;

  IF v_dest_status = 'rejected' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_rejected');
  END IF;

  -- Identity submitted and this is the locked number: allow while pending.
  IF m = 'mobile_money' THEN
    SELECT * INTO v_binding
    FROM public.user_identity_bindings
    WHERE user_id = w.user_id
      AND status <> 'revoked'
      AND coalesce(locked_payout_number, '') <> ''
      AND regexp_replace(coalesce(locked_payout_number, ''), '[^0-9]', '', 'g')
          LIKE '%' || right(regexp_replace(coalesce(w.mobile_money_number, ''), '[^0-9]', '', 'g'), 9)
    LIMIT 1;

    IF v_binding.id IS NOT NULL
       AND coalesce(btrim(coalesce(v_binding.national_id, v_binding.linked_national_id, '')), '') <> ''
       AND coalesce(btrim(coalesce(v_binding.id_front_photo_path, '')), '') <> ''
       AND coalesce(btrim(coalesce(v_binding.selfie_photo_path, '')), '') <> '' THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'identity_captured_pending_review');
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', 'unverified');
END;
$$;
