-- Food M1 — owner policy decisions REV-D1 and HND-D1 (2026-10-13).
--
-- NOT APPLIED TO PRODUCTION. Applies after 20261013128000 and before
-- 20261013129000.
--
-- REV-D1 (owner, 2026-10-14). Canteen payments are internal and are NOT
-- reversed. A Food payment is an ordinary wallet_transfer, so the shared
-- sender reversal (reverse_wallet_transfer, drizzle 0451/0453; production-only
-- definitions, not overwritten here) would otherwise let the employee reverse
-- it from their statement. A narrow guard on general_ledger refuses EVERY
-- reversal posting for a Food payment reference (reference 'FOODPAY-…-REV' or
-- key 'reversal:FOODPAY-…'), whoever attempts it; the shared function then
-- fails with nothing posted. There is deliberately no reversal path in Food.

-- HND-D1. Once an order is blocked on its payee, food_pay_order refuses every
-- retry until ANOTHER active Food Coordinator records a decision, with a
-- mandatory reason, through food_resolve_blocked_payment:
--   * 'released'   - the original payee can be paid again: the block is
--                    lifted and the payee is unchanged (never displaced);
--   * 'reassigned' - the original payee still cannot be paid: the resolving
--                    coordinator becomes the payee (wallet and name recorded).
-- Neither makes or retries a payment: the employee pays again themselves,
-- through every normal check.
--
-- ROLLBACK: DROP TRIGGER food_guard_payment_reversal ON general_ledger; DROP
-- FUNCTION food_guard_payment_reversal(), food_resolve_blocked_payment(uuid,text),
-- food_payee_block_reason(uuid,uuid,uuid).

-- ═══════════════ the guard: no reversal of a Food payment ═══════════════
CREATE FUNCTION public.food_guard_payment_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Canteen payments are not reversible. Nothing was changed.' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION public.food_guard_payment_reversal() FROM PUBLIC, anon, authenticated;
-- Fires only for Food payment reversal rows; every other ledger insert skips it.
CREATE TRIGGER food_guard_payment_reversal
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW
  WHEN (NEW.reference_id LIKE 'FOODPAY-%-REV' OR NEW.idempotency_key LIKE 'reversal:FOODPAY-%')
  EXECUTE FUNCTION public.food_guard_payment_reversal();

-- ═══════════════ HND-D1: another active coordinator takes over a blocked order ═══════════════
-- Why a payee cannot be paid now (NULL = they can). Same checks as payment,
-- seen from the ordering employee (the sender).
CREATE FUNCTION public.food_payee_block_reason(p_payee uuid, p_wallet uuid, p_employee uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_owner uuid; p record;
BEGIN
  IF p_wallet IS NOT NULL THEN
    SELECT w.user_id INTO v_owner FROM public.wallets_physical w WHERE w.id = p_wallet;
    IF v_owner IS DISTINCT FROM p_payee THEN RETURN 'wallet no longer belongs to the payee'; END IF;
  END IF;
  IF NOT public.food_is_staff(p_payee) THEN RETURN 'no longer Food staff'; END IF;
  SELECT pr.is_frozen, pr.deleted_at INTO p FROM public.profiles pr WHERE pr.id = p_payee;
  IF p.deleted_at IS NOT NULL THEN RETURN 'account closed'; END IF;
  IF COALESCE(p.is_frozen, false) THEN RETURN 'account frozen'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_payee) THEN RETURN 'cannot sign in'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.food_payee_block_reason(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.food_resolve_blocked_payment(p_order_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_o public.food_orders%ROWTYPE; v_still text; v_new_block text;
        v_wallet uuid; v_name text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_food_coordinator(v_uid) THEN
    RAISE EXCEPTION 'Only the active Food Coordinator can take over a blocked payment' USING ERRCODE='42501'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_o FROM public.food_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF v_uid = v_o.employee_id THEN
    RAISE EXCEPTION 'You cannot take over the payment for your own order' USING ERRCODE='42501'; END IF;
  IF v_uid = v_o.payee_id THEN
    RAISE EXCEPTION 'Another active Food Coordinator must handle this order' USING ERRCODE='42501'; END IF;
  IF v_o.payment_status <> 'pending_payment' OR NOT v_o.payment_resolution_required
     OR v_o.payment_resolution_reason IS DISTINCT FROM 'recipient_ineligible' THEN
    RAISE EXCEPTION 'This order is not blocked on its payee' USING ERRCODE='22023'; END IF;
  -- the original payee can be paid again: release the block, payee unchanged
  v_still := public.food_payee_block_reason(v_o.payee_id, v_o.payee_wallet_id, v_o.employee_id);
  IF v_still IS NULL THEN
    UPDATE public.food_orders
       SET payment_resolution_required = false, payment_resolution_reason = 'block released'
     WHERE id = v_o.id;
    INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
    VALUES (v_o.id, 'payment_block_released', 'pending_payment', 'pending_payment', btrim(p_reason), v_uid);
    PERFORM public.food_audit_write('order', v_o.id, 'payment_block_released',
      jsonb_build_object('payment_resolution_reason', 'recipient_ineligible', 'payee_id', v_o.payee_id),
      jsonb_build_object('payee_id', v_o.payee_id, 'payee_wallet_id', v_o.payee_wallet_id), btrim(p_reason), v_uid);
    RETURN jsonb_build_object('status','pending_payment','action','released','order_id',v_o.id,
                              'payee_id',v_o.payee_id,'payee_name',v_o.payee_name,'payee_wallet_id',v_o.payee_wallet_id);
  END IF;
  -- the new payee must themselves be payable, with a wallet of their own
  SELECT w.id INTO v_wallet FROM public.wallets_physical w WHERE w.user_id = v_uid;
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'You need a Welile wallet to take over this payment' USING ERRCODE='22023'; END IF;
  v_new_block := public.food_payee_block_reason(v_uid, v_wallet, v_o.employee_id);
  IF v_new_block IS NOT NULL THEN
    RAISE EXCEPTION 'You cannot receive this payment (%)', v_new_block USING ERRCODE='22023'; END IF;
  SELECT coalesce(nullif(btrim(full_name), ''), 'Food Coordinator') INTO v_name FROM public.profiles WHERE id = v_uid;

  UPDATE public.food_orders
     SET payee_id = v_uid, payee_wallet_id = v_wallet, payee_name = v_name,
         payment_resolution_required = false, payment_resolution_reason = 'payee reassigned'
   WHERE id = v_o.id;
  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (v_o.id, 'payee_reassigned', 'pending_payment', 'pending_payment', btrim(p_reason), v_uid);
  PERFORM public.food_audit_write('order', v_o.id, 'payee_reassigned',
    jsonb_build_object('payee_id', v_o.payee_id, 'payee_wallet_id', v_o.payee_wallet_id, 'blocked_because', v_still),
    jsonb_build_object('payee_id', v_uid, 'payee_wallet_id', v_wallet, 'payee_name', v_name), btrim(p_reason), v_uid);
  RETURN jsonb_build_object('status','pending_payment','action','reassigned','order_id',v_o.id,'payee_id',v_uid,
                            'payee_name',v_name,'payee_wallet_id',v_wallet,'previous_payee_blocked_because',v_still);
END $$;

REVOKE ALL ON FUNCTION public.food_resolve_blocked_payment(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.food_resolve_blocked_payment(uuid, text) TO authenticated;
