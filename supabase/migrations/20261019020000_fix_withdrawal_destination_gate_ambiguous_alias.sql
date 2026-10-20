-- Fix: withdrawal_destination_gate raised "column reference w.id is ambiguous".
--
-- The advisor guard at the top of the function aliases withdrawal_requests as w
-- inside an EXISTS subquery, but the function also declares a plpgsql variable
-- named w. Any call that reaches the guard fails with SQLSTATE 42702.
-- approve-withdrawal treats an error from this RPC as "destination not verified",
-- so every mobile-money or bank payout confirmation was rejected with
-- DESTINATION_UNVERIFIED, even for verified destinations.
--
-- Only the guard alias changes (w becomes gw). The gate logic is unchanged and
-- still fails closed. It is the only function with this shape.

CREATE OR REPLACE FUNCTION public.withdrawal_destination_gate(p_withdrawal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  w public.withdrawal_requests;
  m text;
  v_dest_status text;
  v_binding record;
begin /* advisor_guard */ if public._direct_client_call() then if not (public.can_view_staff_reports(auth.uid()) or exists (select 1 from public.withdrawal_requests gw where gw.id = p_withdrawal_id and (gw.user_id = auth.uid() or gw.processed_by = auth.uid() or gw.initiated_by = auth.uid() or gw.agent_id = auth.uid() or gw.user_id in (select public.agent_wallet_network_ids(auth.uid()))))) then raise exception 'not authorized' using errcode = '42501'; end if; end if;
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
  IF EXISTS (
    SELECT 1 FROM public.id_verification_exceptions e
    WHERE e.user_id = w.user_id AND e.revoked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'id_verification_exception');
  END IF;
  IF public.payout_destination_is_verified(
       w.user_id, w.payout_method, w.mobile_money_number, w.bank_name, w.bank_account_number) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'verified');
  END IF;
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
       AND coalesce(btrim(coalesce(v_binding.national_id_photo_path, '')), '') <> ''
       AND coalesce(btrim(coalesce(v_binding.selfie_photo_path, '')), '') <> '' THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'identity_captured_pending_review');
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', false, 'reason', 'unverified');
END;
$function$;
