-- Direct mobile money from a partner to the landlord: two screenshots.
--   receipt_photo_path                -> the partner's own "money sent" screenshot (existing column)
--   landlord_confirmation_photo_path  -> the landlord's "money received" screenshot (new)
-- landlord_receipt_photo_path stays the agent's signed paper receipt (direct pay phase 5).
--
-- Adding a parameter changes the signature, so the function is dropped and re-created,
-- which resets grants: they are re-applied below.

ALTER TABLE public.funder_offplatform_rent_payments
  ADD COLUMN IF NOT EXISTS landlord_confirmation_photo_path text;

DROP FUNCTION IF EXISTS public.funder_record_offplatform_rent_payment(uuid, text, numeric, text, text, timestamptz, text);

CREATE FUNCTION public.funder_record_offplatform_rent_payment(
  p_rent_request_id uuid,
  p_method text,
  p_amount numeric,
  p_provider text DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_paid_at timestamptz DEFAULT NULL,
  p_receipt_photo_path text DEFAULT NULL,
  p_landlord_photo_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_fee numeric;
  v_fee_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT (
    public.has_role(v_uid, 'supporter'::public.app_role)
    OR public.psm_is_partner(v_uid)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_available');
  END IF;
  IF NOT public.funder_plan_is_verified(p_rent_request_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_verified');
  END IF;
  IF p_method NOT IN ('mobile_money', 'cash') OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid');
  END IF;
  IF p_method = 'mobile_money' AND (p_provider IS NULL OR p_provider NOT IN ('mtn', 'airtel') OR COALESCE(btrim(p_reference), '') = '') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid');
  END IF;
  -- Photos must sit in the caller's own folder of the receipts bucket.
  IF p_receipt_photo_path IS NOT NULL
     AND (p_receipt_photo_path NOT LIKE v_uid::text || '/%' OR p_receipt_photo_path LIKE '%..%') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid');
  END IF;
  IF p_landlord_photo_path IS NOT NULL
     AND (p_landlord_photo_path NOT LIKE v_uid::text || '/%' OR p_landlord_photo_path LIKE '%..%') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid');
  END IF;

  -- Server computes the fee. A client-supplied amount is ignored.
  v_fee := GREATEST(0, COALESCE(public.self_support_proxy_fee(p_amount), 0));
  v_fee_status := CASE WHEN v_fee > 0 THEN 'awaiting_confirmation' ELSE 'none' END;

  INSERT INTO public.funder_offplatform_rent_payments (
    funder_id, rent_request_id, method, amount, provider, reference, paid_at,
    receipt_photo_path, landlord_confirmation_photo_path, status,
    cover_fee_amount, cover_fee_status
  ) VALUES (
    v_uid, p_rent_request_id, p_method, p_amount,
    CASE WHEN p_method = 'mobile_money' THEN p_provider ELSE NULL END,
    NULLIF(btrim(p_reference), ''),
    COALESCE(p_paid_at, now()),
    p_receipt_photo_path,
    CASE WHEN p_method = 'mobile_money' THEN p_landlord_photo_path ELSE NULL END,
    'pending',
    v_fee,
    v_fee_status
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending', 'cover_fee_amount', v_fee, 'cover_fee_status', v_fee_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.funder_record_offplatform_rent_payment(uuid, text, numeric, text, text, timestamptz, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.funder_record_offplatform_rent_payment(uuid, text, numeric, text, text, timestamptz, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.funder_record_offplatform_rent_payment(uuid, text, numeric, text, text, timestamptz, text, text) TO service_role;
