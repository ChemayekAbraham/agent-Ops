-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Self-support option 2. Phase 5: the agent records the landlord's signed receipt for a Rent Plan the partner paid
-- directly. Same rule as agent_record_landlord_payout_receipt for ordinary payouts: the receipt number exactly as
-- written (3-50 characters), only by the plan's agent; a photo of it is optional and must sit in the agent's own
-- folder. Needs 20261121090000 .. 20261121120000. Closed to everyone but the agent.
-- REQUIRES THE OWNER'S YES before it is applied to production.

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regprocedure('public.direct_pay_approve(uuid, text, text, text)') IS NULL THEN
    RAISE EXCEPTION 'direct pay phase 5: phase 3 (20261121110000) is not applied';
  END IF;
END
$guard$;

ALTER TABLE public.funder_offplatform_rent_payments
  ADD COLUMN IF NOT EXISTS landlord_receipt_number      text,
  ADD COLUMN IF NOT EXISTS landlord_receipt_photo_path  text,
  ADD COLUMN IF NOT EXISTS landlord_receipt_recorded_at timestamptz;

-- The agent's direct-paid Rent Plans, newest first, with what is still missing. One query.
CREATE OR REPLACE FUNCTION public.direct_pay_agent_items(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY (x->>'confirmed_at') DESC)
      FROM (
        SELECT jsonb_build_object(
                 'payment_id', p.id, 'rent_request_id', p.rent_request_id, 'amount', p.amount,
                 'confirmed_at', p.confirmed_at,
                 'tenant_name', tp.full_name, 'landlord_name', ld.name,
                 'partner_first_name', split_part(COALESCE(NULLIF(btrim(pf.full_name), ''), 'Partner'), ' ', 1),
                 'receipt_number', r.receipt_number, 'receipt_code', r.receipt_code,
                 'landlord_receipt_number', p.landlord_receipt_number,
                 'landlord_receipt_recorded_at', p.landlord_receipt_recorded_at,
                 'needs_landlord_receipt', p.landlord_receipt_number IS NULL) AS x
          FROM public.funder_offplatform_rent_payments p
          LEFT JOIN public.rent_requests rr ON rr.id = p.rent_request_id
          LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
          LEFT JOIN public.profiles pf ON pf.id = p.funder_id
          LEFT JOIN public.landlords ld ON ld.id = p.landlord_id
          LEFT JOIN public.landlord_payout_receipts r ON r.id = p.receipt_id
         WHERE p.flow = 'direct_pay' AND p.status = 'confirmed' AND p.agent_id = v_uid
         ORDER BY p.confirmed_at DESC
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))) q), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_agent_items(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_agent_items(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.direct_pay_agent_record_receipt(p_payment_id uuid, p_receipt_number text,
                                                                  p_photo_path text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_number text := btrim(COALESCE(p_receipt_number, ''));
  p public.funder_offplatform_rent_payments%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF char_length(v_number) < 3 OR char_length(v_number) > 50 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'receipt_number_invalid');
  END IF;
  IF p_photo_path IS NOT NULL AND (p_photo_path NOT LIKE v_uid::text || '/%' OR p_photo_path LIKE '%..%') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_photo');
  END IF;
  SELECT * INTO p FROM public.funder_offplatform_rent_payments
   WHERE id = p_payment_id AND flow = 'direct_pay' FOR UPDATE;
  IF NOT FOUND OR p.agent_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF p.status <> 'confirmed' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_confirmed'); END IF;

  UPDATE public.funder_offplatform_rent_payments
     SET landlord_receipt_number = v_number,
         landlord_receipt_photo_path = COALESCE(p_photo_path, landlord_receipt_photo_path),
         landlord_receipt_recorded_at = now()
   WHERE id = p.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'direct_pay_landlord_receipt', 'funder_offplatform_rent_payments', p.id::text, 'direct_pay_landlord_receipt',
          'Agent recorded the landlord''s signed receipt', jsonb_build_object('receipt_number', v_number, 'replaced', p.landlord_receipt_number));
  RETURN jsonb_build_object('ok', true, 'payment_id', p.id, 'landlord_receipt_number', v_number);
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_agent_record_receipt(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_agent_record_receipt(uuid, text, text) TO authenticated;
