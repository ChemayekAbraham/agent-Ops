-- Wallet payment after receipt confirmation (20261013128000).
-- Runs after 10_behaviour.sql in the same session (helpers, menu item mi2,
-- coordinator) with 05_ledger_standin.sql loaded: the ledger here is a LOCAL
-- STAND-IN with the repo's semantics, not the production ledger.

INSERT INTO food_test.ids VALUES
  ('pay_a', 'f0000000-0000-4000-8000-0000000000c1'),
  ('pay_b', 'f0000000-0000-4000-8000-0000000000c2'),
  ('pay_nowallet', 'f0000000-0000-4000-8000-0000000000c3');
INSERT INTO auth.users (id, email) SELECT id, k||'@example.invalid' FROM food_test.ids WHERE k LIKE 'pay\_%';
INSERT INTO public.profiles (id, full_name, email) SELECT id, 'TEST '||upper(k), k||'@example.invalid' FROM food_test.ids WHERE k LIKE 'pay\_%';
INSERT INTO public.user_roles (user_id, role) SELECT id, 'employee' FROM food_test.ids WHERE k LIKE 'pay\_%';
INSERT INTO public.wallets_physical (user_id)
SELECT id FROM food_test.ids WHERE k IN ('pay_a','pay_b','coord','emp_ok');

-- order, prepared and handed over: returns the order id
CREATE FUNCTION pg_temp.delivered_order(p_employee text, p_key text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  PERFORM food_test.act_as(food_test.id(p_employee));
  v := (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi2'), 'quantity', 1)), p_key, 'wallet')->>'order_id')::uuid;
  PERFORM food_test.act_as(food_test.id('coord'));
  PERFORM public.food_set_fulfilment(v, 'preparing');
  PERFORM public.food_set_fulfilment(v, 'ready');
  PERFORM public.food_set_fulfilment(v, 'delivered');
  RESET ROLE;
  RETURN v;
END $$;

-- ── before receipt ──
BEGIN;
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.delivered_order('pay_a', 'pay-k1');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '22023', 'PAYS-01 payment is unavailable before the employee confirms receipt');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises(format($$SELECT public.food_confirm_receipt(%L)$$, (SELECT id FROM o)), '42501', 'PAYS-02 the coordinator cannot confirm receipt for the employee');
SELECT food_test.act_as(food_test.id('pay_b'));
SELECT food_test.raises(format($$SELECT public.food_confirm_receipt(%L)$$, (SELECT id FROM o)), '42501', 'PAYS-03 another employee cannot confirm receipt');
SET LOCAL ROLE anon;
SELECT food_test.raises(format($$SELECT public.food_confirm_receipt(%L)$$, (SELECT id FROM o)), '42501', 'PAYS-04 anonymous cannot confirm receipt');
ROLLBACK;

BEGIN;
SELECT food_test.act_as(food_test.id('pay_a'));
CREATE TEMP TABLE o AS SELECT (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi2'), 'quantity', 1)), 'pay-k2', 'wallet')->>'order_id')::uuid AS id;
GRANT ALL ON o TO authenticated, anon;
SELECT food_test.raises(format($$SELECT public.food_confirm_receipt(%L)$$, (SELECT id FROM o)), '22023', 'PAYS-05 receipt cannot be confirmed before the order is handed over');
ROLLBACK;

-- ── the approved path, insufficient funds, retry, duplicate, handover snapshot ──
BEGIN;
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.delivered_order('pay_a', 'pay-k3');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_confirm_receipt((SELECT id FROM o))->>'payee_id')::uuid = food_test.id('coord'),
                    'PAYS-06 receipt snapshots the active coordinator as payee');
SELECT food_test.ok((public.food_confirm_receipt((SELECT id FROM o))->>'status') = 'already_confirmed',
                    'PAYS-07 confirming twice changes nothing');
-- the coordinator hands over AFTER receipt: payment still goes to the snapshot
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_transfer_coordinator(food_test.id('emp_ok'), 'full_transfer', 'handover after receipt confirmation');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'reason') = 'insufficient_funds',
                    'PAYS-08 insufficient funds: the attempt is refused and reported');
RESET ROLE;
SELECT food_test.ok((SELECT payment_status = 'pending_payment' AND transaction_group_id IS NULL FROM public.food_orders WHERE id = (SELECT id FROM o))
                AND NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE source_id = (SELECT id FROM o))
                AND EXISTS (SELECT 1 FROM public.food_order_events WHERE order_id = (SELECT id FROM o) AND event_type = 'payment_failed'),
                    'PAYS-09 ...the order stays unpaid, nothing is posted, the failed attempt is recorded');
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'paid', 'PAYS-10 a manual retry with funds pays');
RESET ROLE;
SELECT food_test.ok((SELECT count(*) = 2
                       AND count(*) FILTER (WHERE user_id = food_test.id('pay_a') AND direction = 'cash_out') = 1
                       AND count(*) FILTER (WHERE user_id = food_test.id('coord') AND direction = 'cash_in') = 1
                       AND bool_and(amount = (SELECT total_ugx FROM public.food_orders WHERE id = (SELECT id FROM o)))
                       AND bool_and(category = 'wallet_transfer' AND ledger_scope = 'wallet' AND wallet_bucket = 'withdrawable'
                                    AND recipient_type = 'user' AND source_table = 'food_orders')
                       AND bool_and(NOT skip_balance_check) AND bool_and(idempotency_key = 'food_order_payment:' || (SELECT id FROM o))
                      FROM public.general_ledger WHERE source_id = (SELECT id FROM o)),
                    'PAYS-11 exactly one employee debit and one credit to the SNAPSHOT coordinator, exact amount, no fee, no platform leg, balance check on');
SELECT food_test.ok((SELECT payment_status = 'paid' AND paid_at IS NOT NULL AND payment_verified_at IS NOT NULL
                            AND transaction_group_id = (SELECT DISTINCT transaction_group_id FROM public.general_ledger WHERE source_id = (SELECT id FROM o))
                       FROM public.food_orders WHERE id = (SELECT id FROM o)),
                    'PAYS-12 the order is paid with the verified transaction reference');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'replayed')::boolean, 'PAYS-13 paying again returns the same payment');
RESET ROLE;
SELECT food_test.ok((SELECT count(*) FROM public.general_ledger WHERE source_id = (SELECT id FROM o)) = 2, 'PAYS-14 ...and posts nothing more');
SELECT food_test.ok((SELECT count(*) FROM public.food_audit WHERE entity = 'order' AND entity_id = (SELECT id FROM o)
                       AND action IN ('receipt_confirmed','payment_failed','paid')) = 3, 'PAYS-15 receipt, failed attempt and payment are audited');
-- a client cannot mark anything paid directly
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$UPDATE public.food_orders SET payment_status='paid' WHERE id=%L$$, (SELECT id FROM o)), '42501', 'PAYS-16 a client cannot set payment status');
ROLLBACK;

-- ── verification failure rolls everything back ──
BEGIN;
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.delivered_order('pay_a', 'pay-k4');
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.food_confirm_receipt((SELECT id FROM o));
RESET ROLE; UPDATE ledger_test.mode SET m = 'short';
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), 'XX000', 'PAYS-17 a posting that does not verify (one leg missing) is refused');
RESET ROLE; UPDATE ledger_test.mode SET m = 'skew';
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), 'XX000', 'PAYS-18 a posting with the wrong amount is refused');
RESET ROLE;
SELECT food_test.ok((SELECT payment_status = 'pending_payment' FROM public.food_orders WHERE id = (SELECT id FROM o))
                AND NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE source_id = (SELECT id FROM o)),
                    'PAYS-19 ...and nothing is left behind: unpaid, no ledger rows');
ROLLBACK;

-- ── refusals ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000), (food_test.id('coord'), 100000);
-- open problem report blocks payment; resolving it unblocks
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.delivered_order('pay_a', 'pay-k5');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.food_confirm_receipt((SELECT id FROM o));
CREATE TEMP TABLE x AS SELECT (public.food_raise_exception('MISSING_ITEM', 'No sauce', (SELECT id FROM o))->>'exception_id')::uuid AS id;
GRANT ALL ON x TO authenticated, anon;
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '22023', 'PAYS-20 an open problem report blocks payment');
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_resolve_exception((SELECT id FROM x), 'Sauce brought to the desk');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'paid', 'PAYS-21 once resolved, payment proceeds');
-- the coordinator's own order: no self-payment
CREATE TEMP TABLE s (id uuid); GRANT ALL ON s TO authenticated, anon;
INSERT INTO s SELECT pg_temp.delivered_order('coord', 'pay-k6');
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_confirm_receipt((SELECT id FROM s));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM s)), '42501', 'PAYS-22 a coordinator cannot pay themselves');
-- another employee cannot pay someone else's order
SELECT food_test.act_as(food_test.id('pay_b'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM s)), '42501', 'PAYS-23 nobody but the ordering employee can pay');
SET LOCAL ROLE anon;
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM s)), '42501', 'PAYS-24 anonymous cannot pay');
ROLLBACK;

BEGIN;
-- missing wallets are refused and never created
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.delivered_order('pay_nowallet', 'pay-k7');
SELECT food_test.act_as(food_test.id('pay_nowallet'));
SELECT public.food_confirm_receipt((SELECT id FROM o));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), 'P0002', 'PAYS-25 an employee without a wallet is refused');
RESET ROLE;
DELETE FROM public.wallets_physical WHERE user_id = food_test.id('coord');
CREATE TEMP TABLE p (id uuid); GRANT ALL ON p TO authenticated, anon;
INSERT INTO p SELECT pg_temp.delivered_order('pay_b', 'pay-k8');
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_b'), 100000);
SELECT food_test.act_as(food_test.id('pay_b'));
SELECT public.food_confirm_receipt((SELECT id FROM p));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM p)), 'P0002', 'PAYS-26 a coordinator without a wallet is refused');
RESET ROLE;
SELECT food_test.ok((SELECT count(*) FROM public.wallets_physical WHERE user_id IN (food_test.id('coord'), food_test.id('pay_nowallet'))) = 0,
                    'PAYS-27 ...and no wallet is created');
-- a cancelled order cannot be received
SELECT food_test.act_as(food_test.id('pay_b'));
CREATE TEMP TABLE c AS SELECT (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi2'), 'quantity', 1)), 'pay-k9', 'wallet')->>'order_id')::uuid AS id;
GRANT ALL ON c TO authenticated, anon;
SELECT public.food_cancel_my_order((SELECT id FROM c), 'changed my mind');
SELECT food_test.raises(format($$SELECT public.food_confirm_receipt(%L)$$, (SELECT id FROM c)), '22023', 'PAYS-28 a cancelled order cannot be received or paid');
ROLLBACK;

-- ── reversal and reconciliation ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.delivered_order('pay_a', 'pay-k10');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.food_confirm_receipt((SELECT id FROM o));
SELECT public.food_pay_order((SELECT id FROM o));
SELECT food_test.ok((public.food_verify_payment((SELECT id FROM o))->>'verified')::boolean, 'PAYS-29 an intact payment verifies');
SELECT food_test.act_as(food_test.id('pay_b'));
SELECT food_test.raises(format($$SELECT public.food_verify_payment(%L)$$, (SELECT id FROM o)), '42501', 'PAYS-30 another employee cannot run verification on this order');
-- a reversal is posted for the payment (convention '<reference>-REV')
RESET ROLE;
-- REV-D1 (20261013128500) refuses unauthorised reversal rows; switched off in
-- this transaction only, to simulate a reversal reaching the ledger by any route
ALTER TABLE public.general_ledger DISABLE TRIGGER food_guard_payment_reversal;
INSERT INTO public.general_ledger (transaction_group_id, user_id, amount, direction, category, ledger_scope, source_table, reference_id)
SELECT gen_random_uuid(), food_test.id('pay_a'), total_ugx, 'cash_in', 'wallet_transfer', 'wallet', 'wallet_transactions',
       'FOODPAY-' || order_reference || '-REV' FROM public.food_orders WHERE id = (SELECT id FROM o);
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_verify_payment((SELECT id FROM o))->>'status') = 'payment_reversed', 'PAYS-31 a reversed payment is detected');
RESET ROLE;
SELECT food_test.ok((SELECT payment_status = 'payment_reversed' FROM public.food_orders WHERE id = (SELECT id FROM o))
                AND EXISTS (SELECT 1 FROM public.food_order_events WHERE order_id = (SELECT id FROM o) AND event_type = 'payment_reversed'),
                    'PAYS-32 ...the order is no longer treated as paid, and the change is recorded');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '22023', 'PAYS-33 a reversed order is not silently paid again');
ROLLBACK;

-- ── the payment function's own contract ──
SELECT food_test.ok((SELECT pronargs = 1 FROM pg_proc WHERE proname = 'food_pay_order'),
                    'PAYS-34 food_pay_order takes only the order id (no amount, recipient, wallet or status)');
SELECT food_test.ok((SELECT prosrc !~* 'skip_balance_check\s*=>\s*true' AND prosrc ~* 'idempotency_key\s*=>' FROM pg_proc WHERE proname = 'food_pay_order'),
                    'PAYS-35 it never skips the balance check and always posts with a fixed key');
SELECT food_test.ok((SELECT bool_and(proconfig::text LIKE '%pg_temp%') FROM pg_proc
                      WHERE proname IN ('food_pay_order','food_confirm_receipt','food_verify_payment')),
                    'PAYS-36 search_path pins pg_temp last');
