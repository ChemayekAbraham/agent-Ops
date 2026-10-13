-- Food M1 — wallet payment after the employee confirms receipt.
--
-- NOT APPLIED TO PRODUCTION. Applies after 20261013127000 (and, in
-- production, after 20261013126000, which removes direct ledger access from
-- signed-in users; these definer functions call the ledger as their owner,
-- which must hold EXECUTE on create_ledger_transaction other than through
-- PUBLIC: production evidence pack E6).
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
--      right people, right amount, right direction, scope, source and
--      reference, not reversed, not already recorded) before the order is
--      marked paid. Ledger legs, verification, the attempt record and the paid
--      status commit together or not at all.
--
-- Never trusted: client amounts, recipients, wallet ids, receipt or payment
-- status. None of them is a parameter.
--
-- Refused (nothing posted): payment before receipt; anyone but the ordering
-- employee; an order with an open problem report; paying yourself; a payment
-- status other than pending_payment; a missing wallet on either side (never
-- created here); Wallet Ops freezes; an insufficient spendable balance.
-- Blocked for authorised resolution (nothing posted, recorded, escalatable):
-- the snapshotted payee is no longer Food staff or fails the shared recipient
-- gate check_transfer_recipient_eligibility (frozen, closed, no account, self).
--
-- Before posting, food_pay_order applies the same wallet gates the
-- wallet-transfer edge function applies, unchanged: the Wallet Ops controls
-- (maintenance_mode / maintenance_until, withdrawals_paused; the "debit" scope
-- of checkTreasuryGuard), the canonical spendable figure
-- get_user_available_balance (withdrawable less funder holds and, while
-- advance_withdrawals_paused is on, the advance-locked amount), and the shared
-- recipient gate, called exactly as wallet-transfer calls it (item NULL,
-- sender = payer). Its contract, (p_recipient_id uuid, p_item text,
-- p_sender_id uuid) RETURNS TABLE(eligible, reason, display_name,
-- has_wallet), is taken from drizzle/migrations/0045 and the generated types;
-- it is called by name, never re-implemented, so a different live signature
-- fails the payment closed. Agent Advance recovery is untouched: the payee's
-- credit is an ordinary wallet_transfer, so get_agent_sweepable_withdrawable
-- treats it exactly as any peer transfer; a Food Coordinator gets no
-- treatment of their own.
--
-- Attempts. Every successful posting is kept in food_payment_attempts with
-- its reference, idempotency key, transaction, payee and time. Attempt 1 uses
-- 'FOODPAY-<order reference>' / 'food_order_payment:<order id>'; attempt n>1
-- adds '-A<n>' / ':<n>'. A new attempt exists only after a reversal and an
-- explicit, recorded authorisation (food_authorize_payment_retry); it never
-- charges anyone by itself and never changes the payee.
--
-- Reversals. A Food payment is an ordinary wallet_transfer, so the sender (the
-- employee) can reverse it with the standard reverse_wallet_transfer while the
-- coordinator has not withdrawn (drizzle/migrations/0451 and 0453; the
-- statement shows a Reverse button for it). Food does NOT prevent that; it
-- detects and records it. The mechanism writes two markers, reference
-- '<reference>-REV' and idempotency key 'reversal:<reference>', and returns
-- only what the coordinator still holds (it can be partial). Food matches both
-- markers exactly, records the amount actually returned and when, marks the
-- order payment_reversed and flags it for authorised resolution. Detection:
-- food_verify_payment, a pay retry, and food_reconcile_payments (capped batch
-- for the active coordinator or a service_role scheduler). The live reversal
-- functions have not been read in production; the repo definitions are the
-- evidence.
--
-- Uses the ledger as it exists: create_ledger_transaction (never with
-- skip_balance_check), general_ledger and wallets_physical (read only). No
-- shared object is changed.
--
-- ROLLBACK: DROP FUNCTION food_authorize_payment_retry(uuid, text),
-- food_reconcile_payments(integer), food_verify_payment(uuid),
-- food_confirm_receipt(uuid), food_mark_payment_reversed(uuid, uuid, jsonb, uuid),
-- food_payment_problem(food_orders), food_payment_reference(text, integer),
-- food_payment_key(uuid, integer); DROP TABLE food_payment_attempts; re-run
-- food_pay_order from 20261012120000; restore NOT NULL on
-- food_order_events.actor_id and food_audit.actor_id (dropping their
-- *_actor_required checks); DROP the columns received_at, received_by,
-- payee_id, payment_verified_at, payment_attempt, payment_resolution_required,
-- payment_resolution_reason and the two order constraints; restore the
-- payment_status CHECK without 'payment_reversed'.

-- ═══════════════ order columns ═══════════════
ALTER TABLE public.food_orders
  ADD COLUMN received_at                 timestamptz,
  ADD COLUMN received_by                 uuid REFERENCES public.profiles(id),
  ADD COLUMN payee_id                    uuid REFERENCES public.profiles(id),
  ADD COLUMN payment_verified_at         timestamptz,
  -- the attempt the order is currently on; > 1 only after an authorised retry
  ADD COLUMN payment_attempt             integer NOT NULL DEFAULT 1 CHECK (payment_attempt >= 1),
  -- set when a payment was reversed or the payee became ineligible; cleared by
  -- a later successful payment or an authorised new attempt
  ADD COLUMN payment_resolution_required boolean NOT NULL DEFAULT false,
  ADD COLUMN payment_resolution_reason   text;

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

-- Reversal detection may run with no signed-in user (a scheduler running as
-- service_role). Only that one record type may carry no actor; every other
-- event and audit row still names who did it.
ALTER TABLE public.food_order_events ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.food_order_events
  ADD CONSTRAINT food_order_events_actor_required
  CHECK (actor_id IS NOT NULL OR event_type = 'payment_reversed');
ALTER TABLE public.food_audit ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.food_audit
  ADD CONSTRAINT food_audit_actor_required
  CHECK (actor_id IS NOT NULL OR action = 'payment_reversed');

-- ═══════════════ payment attempts: the permanent history ═══════════════
-- One row per SUCCESSFUL posting. Never deleted or overwritten except to
-- record what later happened to that posting (reversal, partial or full).
CREATE TABLE public.food_payment_attempts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES public.food_orders(id),
  attempt_no            integer NOT NULL CHECK (attempt_no >= 1),
  payer_id              uuid NOT NULL REFERENCES public.profiles(id),
  payee_id              uuid NOT NULL REFERENCES public.profiles(id),
  amount                numeric NOT NULL CHECK (amount > 0),
  reference             text NOT NULL UNIQUE,
  idempotency_key       text NOT NULL UNIQUE,
  transaction_group_id  uuid NOT NULL UNIQUE,
  paid_at               timestamptz NOT NULL,
  authorised_by         uuid REFERENCES public.profiles(id),   -- NULL on attempt 1
  authorised_reason     text,
  state                 text NOT NULL DEFAULT 'paid'
                          CHECK (state IN ('paid','reversed','ledger_mismatch')),
  reversed_amount       numeric CHECK (reversed_amount IS NULL OR reversed_amount >= 0),
  reversal_reference    text,
  reversal_posted_at    timestamptz,
  problem_detected_at   timestamptz,
  UNIQUE (order_id, attempt_no),
  CHECK (attempt_no = 1 OR (authorised_by IS NOT NULL AND btrim(coalesce(authorised_reason,'')) <> '')));
ALTER TABLE public.food_payment_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY food_attempts_read ON public.food_payment_attempts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.food_orders o WHERE o.id = order_id
                   AND (o.employee_id = auth.uid() OR public.is_food_coordinator(auth.uid()))));
REVOKE ALL ON public.food_payment_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.food_payment_attempts TO authenticated;

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

-- ═══════════════ payment identity and integrity helpers (internal) ═══════════════
-- Ledger reference of an order's payment attempt. Attempt 1 keeps the
-- original form; later attempts are distinct, so a reversed posting (and its
-- '-REV' / 'reversal:' markers) can never be matched to, or reused by, a new one.
CREATE FUNCTION public.food_payment_reference(p_order_reference text, p_attempt integer)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT 'FOODPAY-' || p_order_reference || CASE WHEN p_attempt > 1 THEN '-A' || p_attempt ELSE '' END;
$$;
CREATE FUNCTION public.food_payment_key(p_order_id uuid, p_attempt integer)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT 'food_order_payment:' || p_order_id::text || CASE WHEN p_attempt > 1 THEN ':' || p_attempt ELSE '' END;
$$;

-- State of a paid order's current posting. NULL problem = intact. Otherwise
-- the problem and, for a reversal, what the standard mechanism recorded:
-- the amount actually returned to the employee (may be less than paid), the
-- reversal reference and when it was posted. Exact matches only.
CREATE FUNCTION public.food_payment_problem(p_order public.food_orders)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ref text := public.food_payment_reference(p_order.order_reference, p_order.payment_attempt);
        v_ok boolean; v_amt numeric; v_at timestamptz; v_marked boolean;
BEGIN
  SELECT count(*) = 2
     AND count(*) FILTER (WHERE g.user_id = p_order.employee_id AND g.direction = 'cash_out') = 1
     AND count(*) FILTER (WHERE g.user_id = p_order.payee_id AND g.direction = 'cash_in') = 1
     AND bool_and(g.amount = p_order.total_ugx AND g.category = 'wallet_transfer' AND g.ledger_scope = 'wallet'
                  AND g.reference_id = v_ref)
    INTO v_ok
    FROM public.general_ledger g WHERE g.transaction_group_id = p_order.transaction_group_id;
  -- the two markers reverse_wallet_transfer writes (drizzle 0451)
  SELECT EXISTS (SELECT 1 FROM public.general_ledger g
                  WHERE g.idempotency_key = 'reversal:' || v_ref OR g.reference_id = v_ref || '-REV')
    INTO v_marked;
  IF v_marked THEN
    SELECT sum(g.amount), max(g.created_at) INTO v_amt, v_at
      FROM public.general_ledger g
     WHERE g.reference_id = v_ref || '-REV' AND g.direction = 'cash_in'
       AND g.user_id = p_order.employee_id AND g.category = 'wallet_transfer';
    RETURN jsonb_build_object('problem','reversal_posted','reference',v_ref,
      'reversal_reference', v_ref || '-REV', 'reversed_amount', v_amt, 'reversal_posted_at', v_at,
      'partial', v_amt IS NOT NULL AND v_amt < p_order.total_ugx);
  END IF;
  IF NOT coalesce(v_ok, false) THEN
    RETURN jsonb_build_object('problem','ledger_legs_do_not_match','reference',v_ref);
  END IF;
  RETURN jsonb_build_object('problem', NULL, 'reference', v_ref);
END $$;

-- paid -> payment_reversed for exactly the posting that was checked. Never
-- overwrites a newer state: if the order moved on (another attempt, another
-- status) nothing changes. Returns whether it changed the order.
CREATE FUNCTION public.food_mark_payment_reversed(p_order_id uuid, p_group uuid, p_problem jsonb, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_reason text := p_problem->>'problem';
BEGIN
  UPDATE public.food_orders
     SET payment_status = 'payment_reversed', payment_resolution_required = true,
         payment_resolution_reason = v_reason
   WHERE id = p_order_id AND payment_status = 'paid' AND transaction_group_id = p_group;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.food_payment_attempts
     SET state = CASE WHEN v_reason = 'reversal_posted' THEN 'reversed' ELSE 'ledger_mismatch' END,
         reversed_amount = (p_problem->>'reversed_amount')::numeric,
         reversal_reference = p_problem->>'reversal_reference',
         reversal_posted_at = (p_problem->>'reversal_posted_at')::timestamptz,
         problem_detected_at = now()
   WHERE transaction_group_id = p_group;
  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (p_order_id, 'payment_reversed', 'paid', 'payment_reversed',
          v_reason || CASE WHEN p_actor IS NULL THEN ' (system reconciliation)' ELSE '' END, p_actor);
  PERFORM public.food_audit_write('order', p_order_id, 'payment_reversed',
    jsonb_build_object('payment_status','paid','transaction_group_id',p_group),
    jsonb_build_object('payment_status','payment_reversed') || p_problem, NULL, p_actor);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.food_payment_problem(public.food_orders),
                       public.food_mark_payment_reversed(uuid, uuid, jsonb, uuid),
                       public.food_payment_reference(text, integer),
                       public.food_payment_key(uuid, integer)
  FROM PUBLIC, anon, authenticated;

-- ═══════════════ 2-4. pay, verify, mark paid ═══════════════
CREATE OR REPLACE FUNCTION public.food_pay_order(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid(); v_o public.food_orders%ROWTYPE;
  v_ref text; v_key text; v_group uuid; v_ok boolean;
  v_maint boolean; v_until text; v_wpaused boolean; v_short boolean := false;
  v_elig boolean; v_elig_reason text; v_problem jsonb; v_block text;
  v_auth_by uuid; v_auth_reason text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT * INTO v_o FROM public.food_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF v_o.employee_id <> v_uid THEN
    RAISE EXCEPTION 'Only the person who placed this order can pay for it' USING ERRCODE='42501'; END IF;

  -- retry or second tab: the payment stands and nothing is posted twice; a
  -- payment reversed since then is reported as reversed, never as paid
  IF v_o.payment_status = 'paid' THEN
    v_problem := public.food_payment_problem(v_o);
    IF v_problem->>'problem' IS NOT NULL THEN
      PERFORM public.food_mark_payment_reversed(v_o.id, v_o.transaction_group_id, v_problem, v_uid);
      RETURN jsonb_build_object('status','payment_reversed','order_id',v_o.id) || v_problem;
    END IF;
    RETURN jsonb_build_object('status','paid','order_id',v_o.id,
                              'transaction_group_id',v_o.transaction_group_id,'replayed',true);
  END IF;
  IF v_o.payment_status = 'payment_reversed' THEN
    RAISE EXCEPTION 'This order''s payment was reversed. It needs an authorised resolution before it can be paid again.'
      USING ERRCODE='22023'; END IF;
  IF v_o.received_at IS NULL OR v_o.payee_id IS NULL THEN
    RAISE EXCEPTION 'Confirm that you received your order before paying' USING ERRCODE='22023'; END IF;
  IF v_o.payment_status <> 'pending_payment' THEN
    RAISE EXCEPTION 'This order cannot be paid (%)', v_o.payment_status USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.food_exceptions e WHERE e.order_id = v_o.id AND e.resolved_at IS NULL) THEN
    RAISE EXCEPTION 'This order has an open problem report; it must be resolved before payment'
      USING ERRCODE='22023'; END IF;
  IF v_o.payee_id = v_uid THEN
    RAISE EXCEPTION 'A Food Coordinator cannot pay themselves for their own order' USING ERRCODE='42501'; END IF;

  -- The payee is the coordinator snapshotted at receipt; a handover never
  -- redirects it. Their eligibility is re-checked now: Food staff, and the
  -- shared recipient gate every wallet transfer passes (frozen, closed, no
  -- account, self), called exactly as wallet-transfer calls it. If they no
  -- longer qualify the order is blocked for authorised resolution and
  -- nothing is posted.
  IF NOT public.food_is_staff(v_o.payee_id) THEN
    v_block := 'The Food Coordinator for this order is no longer Food staff';
  ELSE
    SELECT e.eligible, e.reason INTO v_elig, v_elig_reason
      FROM public.check_transfer_recipient_eligibility(
             p_recipient_id => v_o.payee_id, p_item => NULL::text, p_sender_id => v_uid) e;
    IF NOT COALESCE(v_elig, false) THEN v_block := COALESCE(v_elig_reason, 'not eligible'); END IF;
  END IF;
  IF v_block IS NOT NULL THEN
    UPDATE public.food_orders
       SET payment_resolution_required = true, payment_resolution_reason = 'recipient_ineligible'
     WHERE id = v_o.id;
    INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
    VALUES (v_o.id, 'payment_blocked', v_o.payment_status, v_o.payment_status, v_block, v_uid);
    PERFORM public.food_audit_write('order', v_o.id, 'payment_blocked', NULL,
      jsonb_build_object('reason','recipient_ineligible','detail',v_block,'payee_id',v_o.payee_id), NULL, v_uid);
    RETURN jsonb_build_object('status','blocked','order_id',v_o.id,'reason','recipient_ineligible',
                              'detail',v_block,'escalate',true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.wallets_physical w WHERE w.user_id = v_uid) THEN
    RAISE EXCEPTION 'You do not have a Welile wallet' USING ERRCODE='P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wallets_physical w WHERE w.user_id = v_o.payee_id) THEN
    RAISE EXCEPTION 'The Food Coordinator does not have a Welile wallet; payment cannot be made'
      USING ERRCODE='P0002'; END IF;
  IF v_o.total_ugx IS NULL OR v_o.total_ugx <= 0 THEN
    RAISE EXCEPTION 'Nothing to pay on this order' USING ERRCODE='22023'; END IF;

  -- Wallet Ops controls, read as other SQL money paths read them. An
  -- unreadable maintenance_until keeps the freeze on (fails closed).
  SELECT coalesce(bool_or(c.enabled) FILTER (WHERE c.control_key = 'maintenance_mode'), false),
         max(c.value) FILTER (WHERE c.control_key = 'maintenance_until'),
         coalesce(bool_or(c.enabled) FILTER (WHERE c.control_key = 'withdrawals_paused'), false)
    INTO v_maint, v_until, v_wpaused
    FROM public.treasury_controls c
   WHERE c.control_key IN ('maintenance_mode', 'maintenance_until', 'withdrawals_paused');
  IF v_maint AND v_until IS NOT NULL THEN
    BEGIN v_maint := v_until::timestamptz > now();
    EXCEPTION WHEN others THEN v_maint := true; END;
  END IF;
  IF v_maint OR v_wpaused THEN
    RAISE EXCEPTION 'Wallet payments are temporarily paused. Nothing was charged; try again later.'
      USING ERRCODE = '55000'; END IF;

  -- this attempt's own identity: never the key of a reversed attempt
  v_ref := public.food_payment_reference(v_o.order_reference, v_o.payment_attempt);
  v_key := public.food_payment_key(v_o.id, v_o.payment_attempt);

  -- the spendable figure wallet-transfer gates on; Food adds no rule of its own
  v_short := COALESCE(public.get_user_available_balance(v_uid), 0) < v_o.total_ugx;

  IF NOT v_short THEN
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
    -- the ledger's own balance check remains the final word
    IF SQLERRM ILIKE 'Insufficient%balance%' THEN v_short := true; ELSE RAISE; END IF;
  END;
  END IF;

  IF v_short THEN
    -- nothing was posted (the block rolled back, or never ran); record the attempt only
    INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
    VALUES (v_o.id, 'payment_failed', v_o.payment_status, v_o.payment_status, 'insufficient_funds', v_uid);
    PERFORM public.food_audit_write('order', v_o.id, 'payment_failed', NULL,
      jsonb_build_object('reason','insufficient_funds'), NULL, v_uid);
    RETURN jsonb_build_object('status','failed','order_id',v_o.id,'reason','insufficient_funds');
  END IF;

  -- independent verification: what the ledger actually holds for this group,
  -- and that this attempt's posting has not been reversed
  SELECT count(*) = 2
     AND count(*) FILTER (WHERE g.user_id = v_uid AND g.direction = 'cash_out') = 1
     AND count(*) FILTER (WHERE g.user_id = v_o.payee_id AND g.direction = 'cash_in') = 1
     AND bool_and(g.amount = v_o.total_ugx AND g.category = 'wallet_transfer'
                  AND g.ledger_scope = 'wallet' AND g.source_table = 'food_orders'
                  AND g.source_id::text = v_o.id::text AND g.reference_id = v_ref)
    INTO v_ok
    FROM public.general_ledger g WHERE g.transaction_group_id = v_group;
  IF coalesce(v_ok, false) AND EXISTS (SELECT 1 FROM public.general_ledger g
       WHERE g.idempotency_key = 'reversal:' || v_ref OR g.reference_id = v_ref || '-REV') THEN
    v_ok := false;
  END IF;
  IF coalesce(v_ok, false) AND EXISTS (SELECT 1 FROM public.food_payment_attempts a
       WHERE a.transaction_group_id = v_group) THEN
    v_ok := false;   -- a group already recorded for another attempt is never reused
  END IF;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'The payment could not be verified in the ledger; nothing was charged'
      USING ERRCODE='XX000';
  END IF;

  -- who authorised this attempt (attempt > 1 only), from the authorisation event
  IF v_o.payment_attempt > 1 THEN
    SELECT e.actor_id, e.note INTO v_auth_by, v_auth_reason
      FROM public.food_order_events e
     WHERE e.order_id = v_o.id AND e.event_type = 'payment_retry_authorised'
     ORDER BY e.created_at DESC LIMIT 1;
  END IF;
  INSERT INTO public.food_payment_attempts (order_id, attempt_no, payer_id, payee_id, amount, reference,
    idempotency_key, transaction_group_id, paid_at, authorised_by, authorised_reason)
  VALUES (v_o.id, v_o.payment_attempt, v_uid, v_o.payee_id, v_o.total_ugx, v_ref, v_key, v_group, now(),
          v_auth_by, v_auth_reason);
  UPDATE public.food_orders
     SET payment_status = 'paid', paid_at = now(), transaction_group_id = v_group,
         payment_verified_at = now(), payment_resolution_required = false, payment_resolution_reason = NULL
   WHERE id = v_o.id;
  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (v_o.id, 'paid', 'pending_payment', 'paid', v_ref, v_uid);
  PERFORM public.food_audit_write('order', v_o.id, 'paid',
    jsonb_build_object('payment_status','pending_payment'),
    jsonb_build_object('payment_status','paid','transaction_group_id',v_group,'payee_id',v_o.payee_id,
                       'amount',v_o.total_ugx,'reference',v_ref,'attempt',v_o.payment_attempt), NULL, v_uid);

  RETURN jsonb_build_object('status','paid','order_id',v_o.id,'transaction_group_id',v_group,
                            'amount',v_o.total_ugx,'attempt',v_o.payment_attempt,'replayed',false);
END $$;

-- ═══════════════ reconciliation of a paid order ═══════════════
-- Callable by the active coordinator, or by the employee for their own order.
CREATE FUNCTION public.food_verify_payment(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_o public.food_orders%ROWTYPE; v_problem jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT * INTO v_o FROM public.food_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF v_o.employee_id <> v_uid AND NOT public.is_active_food_coordinator(v_uid) THEN
    RAISE EXCEPTION 'Not allowed to verify this order' USING ERRCODE='42501'; END IF;
  IF v_o.payment_status <> 'paid' THEN
    RETURN jsonb_build_object('status', v_o.payment_status, 'order_id', v_o.id);
  END IF;

  v_problem := public.food_payment_problem(v_o);
  IF v_problem->>'problem' IS NULL THEN
    UPDATE public.food_orders SET payment_verified_at = now() WHERE id = v_o.id;
    RETURN jsonb_build_object('status','paid','order_id',v_o.id,'verified',true);
  END IF;
  PERFORM public.food_mark_payment_reversed(v_o.id, v_o.transaction_group_id, v_problem, v_uid);
  RETURN jsonb_build_object('status','payment_reversed','order_id',v_o.id,'reason',v_problem->>'problem') || v_problem;
END $$;

-- Batch re-check of paid orders, least recently verified first. Explicit cap
-- (1..500, default 100) so a backlog is visible, never unbounded. For the
-- active coordinator, or a scheduler running as service_role (scheduling it
-- is an owner decision; nothing schedules it here). It only ever moves a
-- 'paid' order to 'payment_reversed' for the posting it checked; it never
-- posts, never reverses, never charges. Locked rows are skipped, so it is
-- safe to run concurrently and to retry.
CREATE FUNCTION public.food_reconcile_payments(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_o public.food_orders%ROWTYPE; v_problem jsonb;
        v_checked int := 0; v_reversed int := 0; v_service boolean;
BEGIN
  v_service := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') = 'service_role';
  IF NOT (v_service OR public.is_active_food_coordinator(v_uid)) THEN
    RAISE EXCEPTION 'Only the active Food Coordinator can reconcile payments' USING ERRCODE='42501'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'Batch size must be between 1 and 500' USING ERRCODE='22023'; END IF;
  FOR v_o IN SELECT * FROM public.food_orders WHERE payment_status = 'paid'
              ORDER BY payment_verified_at NULLS FIRST, paid_at LIMIT p_limit
              FOR UPDATE SKIP LOCKED LOOP
    v_checked := v_checked + 1;
    v_problem := public.food_payment_problem(v_o);
    IF v_problem->>'problem' IS NULL THEN
      UPDATE public.food_orders SET payment_verified_at = now() WHERE id = v_o.id;
    ELSIF public.food_mark_payment_reversed(v_o.id, v_o.transaction_group_id, v_problem,
                                            CASE WHEN v_service THEN NULL ELSE v_uid END) THEN
      v_reversed := v_reversed + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_checked, 'reversed', v_reversed, 'limit', p_limit,
                            'more_pending', v_checked = p_limit);
END $$;

-- ═══════════════ authorised new attempt after a reversal ═══════════════
-- The only way out of payment_reversed. It charges nobody and posts nothing:
-- it opens a NEW attempt (new reference and key), keeps the same payee
-- (never redirected), and records who authorised it and why. The employee
-- must then pay again themselves. The employee cannot authorise their own.
CREATE FUNCTION public.food_authorize_payment_retry(p_order_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_o public.food_orders%ROWTYPE; v_next int;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_food_coordinator(v_uid) THEN
    RAISE EXCEPTION 'Only the active Food Coordinator can authorise a new payment attempt' USING ERRCODE='42501'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_o FROM public.food_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF v_o.employee_id = v_uid THEN
    RAISE EXCEPTION 'You cannot authorise a new payment attempt for your own order' USING ERRCODE='42501'; END IF;
  IF v_o.payment_status <> 'payment_reversed' THEN
    RAISE EXCEPTION 'Only an order whose payment was reversed can get a new payment attempt (this one is %)',
      v_o.payment_status USING ERRCODE='22023'; END IF;
  v_next := v_o.payment_attempt + 1;
  UPDATE public.food_orders
     SET payment_status = 'pending_payment', payment_attempt = v_next,
         transaction_group_id = NULL, paid_at = NULL, payment_verified_at = NULL,
         payment_resolution_required = false,
         payment_resolution_reason = 'new attempt ' || v_next || ' authorised'
   WHERE id = v_o.id;
  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (v_o.id, 'payment_retry_authorised', 'payment_reversed', 'pending_payment', btrim(p_reason), v_uid);
  PERFORM public.food_audit_write('order', v_o.id, 'payment_retry_authorised',
    jsonb_build_object('payment_status','payment_reversed','attempt',v_o.payment_attempt,
                       'transaction_group_id',v_o.transaction_group_id),
    jsonb_build_object('payment_status','pending_payment','attempt',v_next), btrim(p_reason), v_uid);
  RETURN jsonb_build_object('status','pending_payment','order_id',v_o.id,'attempt',v_next,
                            'payee_id',v_o.payee_id);
END $$;

REVOKE ALL ON FUNCTION public.food_reconcile_payments(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.food_reconcile_payments(integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.food_confirm_receipt(uuid), public.food_verify_payment(uuid),
                       public.food_authorize_payment_retry(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.food_confirm_receipt(uuid), public.food_verify_payment(uuid),
                          public.food_authorize_payment_retry(uuid, text)
  TO authenticated;
-- food_pay_order keeps its existing grant (authenticated only; CREATE OR REPLACE keeps ACLs)
