-- Food M1 — wallet payment after the employee confirms receipt.
--
-- NOT APPLIED TO PRODUCTION. Applies after 20261013127000 (and, in
-- production, after 20261013126000, which removes direct ledger access from
-- signed-in users; these definer functions are unaffected by that).
--
-- APPROVED SEQUENCE (owner, 2026-10-13):
--   1. The Food Coordinator marks the order delivered or collected.
--   2. The EMPLOYEE who placed it confirms receipt. The active coordinator at
--      that moment is snapshotted as the payee; a later handover never
--      redirects this order's payment.
--   3. Payment becomes available to that employee only. It is a personal
--      wallet-to-personal-wallet transfer: the employee's withdrawable wallet
--      to the payee's, the exact order total, no fee, no platform leg.
--   4. The posting is re-read from general_ledger and VERIFIED (two legs,
--      right people, right amount, right direction, scope and source) before
--      the order is marked paid. All of it is one database transaction:
--      ledger legs, verification and paid status commit together or not at all.
--
-- Never trusted: client amounts, recipients, wallet ids, receipt or payment
-- status. None of them is a parameter.
--
-- Refused: payment before receipt; anyone but the ordering employee; an
-- order with an open problem report; paying yourself (the coordinator's own
-- order); a payee who is no longer staff; a missing wallet on either side
-- (never created here); a payment status other than pending_payment.
-- Insufficient funds: the attempt is logged and the order stays unpaid, so
-- the employee can retry. Retries and concurrent calls are idempotent: one
-- order has one fixed ledger key and the order row is locked.
--
-- food_verify_payment re-checks a PAID order against the ledger. If its legs
-- no longer match, or a reversal posting exists for its reference, the order
-- becomes payment_reversed and is never again treated as paid. The reversal
-- marker '<reference>-REV' is the convention the app's own reversal screen
-- uses (TransactionDetailDrawer); the production reversal function has not
-- been read, so this detection must be confirmed against it before release.
--
-- Uses the ledger as it exists: create_ledger_transaction (never with
-- skip_balance_check), general_ledger (read only) and wallets_physical (read
-- only). No shared object is changed.
--
-- ROLLBACK: DROP FUNCTION food_confirm_receipt(uuid), food_verify_payment(uuid);
-- re-run food_pay_order from 20261012120000; DROP the columns received_at,
-- received_by, payee_id, payment_verified_at and the two constraints; restore
-- the payment_status CHECK without 'payment_reversed'.

-- ═══════════════ order columns ═══════════════
ALTER TABLE public.food_orders
  ADD COLUMN received_at         timestamptz,
  ADD COLUMN received_by         uuid REFERENCES public.profiles(id),
  ADD COLUMN payee_id            uuid REFERENCES public.profiles(id),
  ADD COLUMN payment_verified_at timestamptz;

-- only the ordering employee can be the one who received it
ALTER TABLE public.food_orders
  ADD CONSTRAINT food_orders_received_by_owner
  CHECK (received_by IS NULL OR received_by = employee_id);

-- 'paid' requires the whole chain: receipt, payee, ledger transaction, time
ALTER TABLE public.food_orders
  ADD CONSTRAINT food_orders_paid_needs_receipt
  CHECK (payment_status <> 'paid'
         OR (received_at IS NOT NULL AND payee_id IS NOT NULL
             AND transaction_group_id IS NOT NULL AND paid_at IS NOT NULL)) NOT VALID;

ALTER TABLE public.food_orders DROP CONSTRAINT food_orders_payment_status_check;
ALTER TABLE public.food_orders
  ADD CONSTRAINT food_orders_payment_status_check
  CHECK (payment_status IN ('pending_payment','paid','payment_failed',
                            'refund_pending','refunded','payment_reversed'));

-- ═══════════════ 1. the employee confirms receipt ═══════════════
CREATE FUNCTION public.food_confirm_receipt(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_o public.food_orders%ROWTYPE; v_payee uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT * INTO v_o FROM public.food_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF v_o.employee_id <> v_uid THEN
    RAISE EXCEPTION 'Only the person who placed this order can confirm receiving it' USING ERRCODE='42501'; END IF;
  IF v_o.received_at IS NOT NULL THEN
    RETURN jsonb_build_object('status','already_confirmed','order_id',v_o.id,
                              'payee_id',v_o.payee_id,'amount_due',v_o.total_ugx);
  END IF;
  IF v_o.fulfilment_status NOT IN ('delivered','collected') THEN
    RAISE EXCEPTION 'This order has not been handed over yet' USING ERRCODE='22023'; END IF;

  SELECT a.coordinator_id INTO v_payee
    FROM public.food_coordinator_assignments a
   WHERE a.revoked_at IS NULL AND a.access_level = 'active';
  IF v_payee IS NULL THEN
    RAISE EXCEPTION 'There is no active Food Coordinator to pay; try again later' USING ERRCODE='P0002'; END IF;

  UPDATE public.food_orders
     SET received_at = now(), received_by = v_uid, payee_id = v_payee
   WHERE id = v_o.id;
  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (v_o.id, 'receipt_confirmed', v_o.fulfilment_status, v_o.fulfilment_status,
          'Employee confirmed receipt; payment now available', v_uid);
  PERFORM public.food_audit_write('order', v_o.id, 'receipt_confirmed',
    jsonb_build_object('received_at', NULL, 'payee_id', NULL),
    jsonb_build_object('received_by', v_uid, 'payee_id', v_payee), NULL, v_uid);

  RETURN jsonb_build_object('status','confirmed','order_id',v_o.id,
                            'payee_id',v_payee,'amount_due',v_o.total_ugx);
END $$;

-- ═══════════════ 2-4. pay, verify, mark paid ═══════════════
CREATE OR REPLACE FUNCTION public.food_pay_order(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid(); v_o public.food_orders%ROWTYPE;
  v_ref text; v_key text; v_group uuid; v_ok boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT * INTO v_o FROM public.food_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF v_o.employee_id <> v_uid THEN
    RAISE EXCEPTION 'Only the person who placed this order can pay for it' USING ERRCODE='42501'; END IF;

  -- retry or second tab: the first payment stands, nothing is posted twice
  IF v_o.payment_status = 'paid' THEN
    RETURN jsonb_build_object('status','paid','order_id',v_o.id,
                              'transaction_group_id',v_o.transaction_group_id,'replayed',true);
  END IF;
  IF v_o.received_at IS NULL OR v_o.payee_id IS NULL THEN
    RAISE EXCEPTION 'Confirm that you received your order before paying' USING ERRCODE='22023'; END IF;
  IF v_o.payment_status <> 'pending_payment' THEN
    RAISE EXCEPTION 'This order cannot be paid (%)', v_o.payment_status USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.food_exceptions e WHERE e.order_id = v_o.id AND e.resolved_at IS NULL) THEN
    RAISE EXCEPTION 'This order has an open problem report; it must be resolved before payment'
      USING ERRCODE='22023'; END IF;
  IF v_o.payee_id = v_uid THEN
    RAISE EXCEPTION 'A Food Coordinator cannot pay themselves for their own order' USING ERRCODE='42501'; END IF;
  IF NOT public.food_is_staff(v_o.payee_id) THEN
    RAISE EXCEPTION 'The Food Coordinator for this order can no longer receive payment' USING ERRCODE='P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wallets_physical w WHERE w.user_id = v_uid) THEN
    RAISE EXCEPTION 'You do not have a Welile wallet' USING ERRCODE='P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wallets_physical w WHERE w.user_id = v_o.payee_id) THEN
    RAISE EXCEPTION 'The Food Coordinator does not have a Welile wallet; payment cannot be made'
      USING ERRCODE='P0002'; END IF;
  IF v_o.total_ugx IS NULL OR v_o.total_ugx <= 0 THEN
    RAISE EXCEPTION 'Nothing to pay on this order' USING ERRCODE='22023'; END IF;

  v_ref := 'FOODPAY-' || v_o.order_reference;
  v_key := 'food_order_payment:' || v_o.id::text;

  BEGIN
    v_group := public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object('user_id', v_uid, 'amount', v_o.total_ugx, 'direction', 'cash_out',
          'category', 'wallet_transfer', 'ledger_scope', 'wallet',
          'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'food_orders', 'source_id', v_o.id, 'reference_id', v_ref,
          'description', 'Canteen order ' || v_o.order_reference, 'currency', 'UGX'),
        jsonb_build_object('user_id', v_o.payee_id, 'amount', v_o.total_ugx, 'direction', 'cash_in',
          'category', 'wallet_transfer', 'ledger_scope', 'wallet',
          'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'food_orders', 'source_id', v_o.id, 'reference_id', v_ref,
          'description', 'Canteen order ' || v_o.order_reference, 'currency', 'UGX')),
      idempotency_key => v_key);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM ILIKE 'Insufficient%balance%' THEN
      -- nothing was posted (the block rolled back); record the attempt only
      INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
      VALUES (v_o.id, 'payment_failed', v_o.payment_status, v_o.payment_status, 'insufficient_funds', v_uid);
      PERFORM public.food_audit_write('order', v_o.id, 'payment_failed', NULL,
        jsonb_build_object('reason','insufficient_funds'), NULL, v_uid);
      RETURN jsonb_build_object('status','failed','order_id',v_o.id,'reason','insufficient_funds');
    END IF;
    RAISE;
  END;

  -- independent verification: what the ledger actually holds for this group
  SELECT count(*) = 2
     AND count(*) FILTER (WHERE g.user_id = v_uid AND g.direction = 'cash_out') = 1
     AND count(*) FILTER (WHERE g.user_id = v_o.payee_id AND g.direction = 'cash_in') = 1
     AND bool_and(g.amount = v_o.total_ugx AND g.category = 'wallet_transfer'
                  AND g.ledger_scope = 'wallet' AND g.source_table = 'food_orders'
                  AND g.source_id::text = v_o.id::text AND g.reference_id = v_ref)
    INTO v_ok
    FROM public.general_ledger g WHERE g.transaction_group_id = v_group;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'The payment could not be verified in the ledger; nothing was charged'
      USING ERRCODE='XX000';
  END IF;

  UPDATE public.food_orders
     SET payment_status = 'paid', paid_at = now(), transaction_group_id = v_group,
         payment_verified_at = now()
   WHERE id = v_o.id;
  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (v_o.id, 'paid', 'pending_payment', 'paid', v_ref, v_uid);
  PERFORM public.food_audit_write('order', v_o.id, 'paid',
    jsonb_build_object('payment_status','pending_payment'),
    jsonb_build_object('payment_status','paid','transaction_group_id',v_group,'payee_id',v_o.payee_id,
                       'amount',v_o.total_ugx,'reference',v_ref), NULL, v_uid);

  RETURN jsonb_build_object('status','paid','order_id',v_o.id,'transaction_group_id',v_group,
                            'amount',v_o.total_ugx,'replayed',false);
END $$;

-- ═══════════════ reconciliation of a paid order ═══════════════
-- Callable by the active coordinator, or by the employee for their own order.
CREATE FUNCTION public.food_verify_payment(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_o public.food_orders%ROWTYPE; v_ref text; v_ok boolean; v_reason text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT * INTO v_o FROM public.food_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF v_o.employee_id <> v_uid AND NOT public.is_active_food_coordinator(v_uid) THEN
    RAISE EXCEPTION 'Not allowed to verify this order' USING ERRCODE='42501'; END IF;
  IF v_o.payment_status <> 'paid' THEN
    RETURN jsonb_build_object('status', v_o.payment_status, 'order_id', v_o.id);
  END IF;

  v_ref := 'FOODPAY-' || v_o.order_reference;
  SELECT count(*) = 2
     AND count(*) FILTER (WHERE g.user_id = v_o.employee_id AND g.direction = 'cash_out') = 1
     AND count(*) FILTER (WHERE g.user_id = v_o.payee_id AND g.direction = 'cash_in') = 1
     AND bool_and(g.amount = v_o.total_ugx AND g.category = 'wallet_transfer' AND g.ledger_scope = 'wallet')
    INTO v_ok
    FROM public.general_ledger g WHERE g.transaction_group_id = v_o.transaction_group_id;
  IF NOT coalesce(v_ok, false) THEN
    v_reason := 'ledger_legs_do_not_match';
  ELSIF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.reference_id LIKE v_ref || '-REV%') THEN
    v_reason := 'reversal_posted';
  END IF;

  IF v_reason IS NULL THEN
    UPDATE public.food_orders SET payment_verified_at = now() WHERE id = v_o.id;
    RETURN jsonb_build_object('status','paid','order_id',v_o.id,'verified',true);
  END IF;

  UPDATE public.food_orders SET payment_status = 'payment_reversed' WHERE id = v_o.id;
  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (v_o.id, 'payment_reversed', 'paid', 'payment_reversed', v_reason, v_uid);
  PERFORM public.food_audit_write('order', v_o.id, 'payment_reversed',
    jsonb_build_object('payment_status','paid'),
    jsonb_build_object('payment_status','payment_reversed','reason',v_reason), NULL, v_uid);
  RETURN jsonb_build_object('status','payment_reversed','order_id',v_o.id,'reason',v_reason);
END $$;

REVOKE ALL ON FUNCTION public.food_confirm_receipt(uuid), public.food_verify_payment(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.food_confirm_receipt(uuid), public.food_verify_payment(uuid)
  TO authenticated;
-- food_pay_order keeps its existing grant (authenticated only; CREATE OR REPLACE keeps ACLs)
