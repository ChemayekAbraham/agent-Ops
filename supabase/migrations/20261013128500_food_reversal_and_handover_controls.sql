-- Food M1 — owner policy decisions REV-D1 and HND-D1 (2026-10-13).
--
-- NOT APPLIED TO PRODUCTION. Applies after 20261013128000 and before
-- 20261013129000.
--
-- REV-D1. Reversals of a Food payment are permitted ONLY through an
-- authorised, audited process. A Food payment is an ordinary wallet_transfer,
-- so the shared sender reversal (reverse_wallet_transfer, drizzle 0451/0453;
-- production-only definitions, not overwritten here) would let the employee
-- reverse it from their statement. Instead of changing that shared function,
-- a narrow guard on general_ledger refuses any reversal posting for a Food
-- payment reference (reference 'FOODPAY-…-REV' or key 'reversal:FOODPAY-…')
-- unless a matching authorised reversal is in progress. Only
-- food_reverse_payment creates that record, so the guard cannot be satisfied
-- from outside. The shared function then fails with nothing posted.
--   Authorisers: an enabled 'cfo' or 'super_admin' role, never the order's
--   employee or payee (food_can_authorise_payment_reversal; owner to confirm).
--   Full amount only; the coordinator's balance is checked by the ledger. A
--   refusal is recorded; nothing is retried or re-charged automatically.
--
-- HND-D1. If the receipt-time coordinator cannot be paid (the order was
-- blocked), ANOTHER active Food Coordinator takes the exception over with a
-- mandatory reason: they become the payee (their wallet and name are
-- recorded) and the block is cleared. Refused while the original payee is
-- eligible again, so a valid payee is never displaced. No payment is made or
-- retried: the employee pays again themselves, through every normal check.
--
-- ROLLBACK: DROP TRIGGER food_guard_payment_reversal ON general_ledger; DROP
-- FUNCTION food_guard_payment_reversal(), food_reverse_payment(uuid,text),
-- food_resolve_blocked_payment(uuid,text), food_can_authorise_payment_reversal(uuid),
-- food_payee_block_reason(uuid,uuid,uuid); DROP TABLE food_payment_reversals.

-- ═══════════════ the reversal record ═══════════════
CREATE TABLE public.food_payment_reversals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES public.food_orders(id),
  attempt_no            integer NOT NULL,
  reference             text NOT NULL,                 -- the payment's ledger reference
  reversal_reference    text NOT NULL,                 -- reference || '-REV'
  amount                numeric NOT NULL CHECK (amount > 0),
  reason                text NOT NULL CHECK (length(btrim(reason)) >= 10),
  authorised_by         uuid NOT NULL REFERENCES public.profiles(id),
  state                 text NOT NULL CHECK (state IN ('executing','posted','refused')),
  refusal_reason        text,
  transaction_group_id  uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz);
CREATE UNIQUE INDEX food_payment_reversals_one_posted
  ON public.food_payment_reversals (reference) WHERE state = 'posted';
ALTER TABLE public.food_payment_reversals ENABLE ROW LEVEL SECURITY;
CREATE POLICY food_reversals_read ON public.food_payment_reversals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.food_orders o WHERE o.id = order_id
                   AND (o.employee_id = auth.uid() OR public.is_food_coordinator(auth.uid()))));
REVOKE ALL ON public.food_payment_reversals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.food_payment_reversals TO authenticated;

-- ═══════════════ the guard: no unauthorised reversal of a Food payment ═══════════════
CREATE FUNCTION public.food_guard_payment_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.food_payment_reversals r
                  WHERE r.state = 'executing'
                    AND (r.reversal_reference = NEW.reference_id
                         OR 'reversal:' || r.reference = NEW.idempotency_key)) THEN
    RAISE EXCEPTION 'Canteen payments can only be reversed through the authorised Food reversal process. Nothing was changed.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.food_guard_payment_reversal() FROM PUBLIC, anon, authenticated;
-- Fires only for Food payment reversal rows; every other ledger insert skips it.
CREATE TRIGGER food_guard_payment_reversal
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW
  WHEN (NEW.reference_id LIKE 'FOODPAY-%-REV' OR NEW.idempotency_key LIKE 'reversal:FOODPAY-%')
  EXECUTE FUNCTION public.food_guard_payment_reversal();

-- ═══════════════ who may authorise a reversal ═══════════════
CREATE FUNCTION public.food_can_authorise_payment_reversal(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = _user_id AND ur.role::text IN ('cfo', 'super_admin') AND COALESCE(ur.enabled, true));
$$;
REVOKE ALL ON FUNCTION public.food_can_authorise_payment_reversal(uuid) FROM PUBLIC, anon, authenticated;

-- ═══════════════ REV-D1: the authorised, audited reversal ═══════════════
CREATE FUNCTION public.food_reverse_payment(p_order_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_o public.food_orders%ROWTYPE; v_att public.food_payment_attempts%ROWTYPE;
        v_ref text; v_rev_id uuid; v_group uuid; v_ok boolean; v_problem jsonb;
BEGIN
  IF NOT public.food_can_authorise_payment_reversal(v_uid) THEN
    RAISE EXCEPTION 'Only an authorised finance reviewer can reverse a canteen payment' USING ERRCODE='42501'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_o FROM public.food_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF v_uid IN (v_o.employee_id, v_o.payee_id) THEN
    RAISE EXCEPTION 'You cannot authorise a reversal of a payment you made or received' USING ERRCODE='42501'; END IF;
  IF v_o.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'Only a paid order can be reversed (this one is %)', v_o.payment_status USING ERRCODE='22023'; END IF;
  v_problem := public.food_payment_problem(v_o);
  IF v_problem->>'problem' IS NOT NULL THEN
    RAISE EXCEPTION 'This payment is not intact (%); run verification first', v_problem->>'problem' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_att FROM public.food_payment_attempts WHERE transaction_group_id = v_o.transaction_group_id;
  v_ref := v_att.reference;

  INSERT INTO public.food_payment_reversals (order_id, attempt_no, reference, reversal_reference, amount, reason,
                                             authorised_by, state)
  VALUES (v_o.id, v_att.attempt_no, v_ref, v_ref || '-REV', v_att.amount, btrim(p_reason), v_uid, 'executing')
  RETURNING id INTO v_rev_id;

  BEGIN
    -- same markers as the standard reversal, so every detector recognises it
    v_group := public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object('user_id', v_att.payee_id, 'amount', v_att.amount, 'direction', 'cash_out',
          'category', 'wallet_transfer', 'ledger_scope', 'wallet', 'recipient_type', 'user',
          'wallet_bucket', 'withdrawable', 'source_table', 'food_orders', 'source_id', v_o.id,
          'reference_id', v_ref || '-REV', 'description', 'Canteen payment reversed (' || v_o.order_reference || ')',
          'currency', 'UGX'),
        jsonb_build_object('user_id', v_att.payer_id, 'amount', v_att.amount, 'direction', 'cash_in',
          'category', 'wallet_transfer', 'ledger_scope', 'wallet', 'recipient_type', 'user',
          'wallet_bucket', 'withdrawable', 'source_table', 'food_orders', 'source_id', v_o.id,
          'reference_id', v_ref || '-REV', 'description', 'Canteen payment returned (' || v_o.order_reference || ')',
          'currency', 'UGX')),
      idempotency_key => 'reversal:' || v_ref);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM ILIKE 'Insufficient%balance%' THEN
      UPDATE public.food_payment_reversals
         SET state = 'refused', refusal_reason = 'coordinator_insufficient_funds', completed_at = now()
       WHERE id = v_rev_id;
      INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
      VALUES (v_o.id, 'payment_reversal_refused', 'paid', 'paid', 'coordinator_insufficient_funds', v_uid);
      PERFORM public.food_audit_write('order', v_o.id, 'payment_reversal_refused', NULL,
        jsonb_build_object('reason','coordinator_insufficient_funds','amount',v_att.amount), btrim(p_reason), v_uid);
      RETURN jsonb_build_object('status','refused','order_id',v_o.id,'reason','coordinator_insufficient_funds');
    END IF;
    RAISE;
  END;

  -- verify the reversal legs landed on the original wallets, exactly
  SELECT count(*) = 2
     AND count(*) FILTER (WHERE g.user_id = v_att.payee_id AND g.direction = 'cash_out' AND g.wallet_id = v_att.payee_wallet_id) = 1
     AND count(*) FILTER (WHERE g.user_id = v_att.payer_id AND g.direction = 'cash_in'  AND g.wallet_id = v_att.payer_wallet_id) = 1
     AND bool_and(g.amount = v_att.amount AND g.reference_id = v_ref || '-REV' AND g.category = 'wallet_transfer')
    INTO v_ok FROM public.general_ledger g WHERE g.transaction_group_id = v_group;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'The reversal could not be verified in the ledger; nothing was changed' USING ERRCODE='XX000'; END IF;

  UPDATE public.food_payment_reversals
     SET state = 'posted', transaction_group_id = v_group, completed_at = now() WHERE id = v_rev_id;
  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (v_o.id, 'payment_reversal_authorised', 'paid', 'paid', btrim(p_reason), v_uid);
  PERFORM public.food_audit_write('order', v_o.id, 'payment_reversal_authorised', NULL,
    jsonb_build_object('amount', v_att.amount, 'reversal_reference', v_ref || '-REV',
                       'transaction_group_id', v_group, 'reversal_id', v_rev_id), btrim(p_reason), v_uid);
  -- record the outcome on the order and the attempt, as for any detected reversal
  SELECT * INTO v_o FROM public.food_orders WHERE id = p_order_id;
  PERFORM public.food_mark_payment_reversed(v_o.id, v_o.transaction_group_id, public.food_payment_problem(v_o), v_uid);
  RETURN jsonb_build_object('status','reversed','order_id',v_o.id,'amount',v_att.amount,
                            'reversal_reference',v_ref || '-REV','transaction_group_id',v_group,'reversal_id',v_rev_id);
END $$;

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
  -- never displace a payee who can be paid again
  v_still := public.food_payee_block_reason(v_o.payee_id, v_o.payee_wallet_id, v_o.employee_id);
  IF v_still IS NULL THEN
    RAISE EXCEPTION 'The original Food Coordinator can be paid again; the employee should simply retry'
      USING ERRCODE='22023'; END IF;
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
  RETURN jsonb_build_object('status','pending_payment','order_id',v_o.id,'payee_id',v_uid,
                            'payee_name',v_name,'payee_wallet_id',v_wallet,'previous_payee_blocked_because',v_still);
END $$;

REVOKE ALL ON FUNCTION public.food_reverse_payment(uuid, text), public.food_resolve_blocked_payment(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.food_reverse_payment(uuid, text), public.food_resolve_blocked_payment(uuid, text)
  TO authenticated;
