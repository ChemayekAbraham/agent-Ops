-- Reversal of a Food payment through the STANDARD sender reversal
-- (drizzle/migrations/0451 reverse_wallet_transfer, 0453
-- wallet_transfer_reversal_status, loaded verbatim by run.sh) and how Food
-- reflects it (20261013128000). Runs after 51_recipient_eligibility.sql in the
-- same session (pay_a, pay_b, coord, pg_temp.received_order / peer_transfer /
-- legs / avail). Repo definitions only: the live reversal functions have not
-- been read in production.

-- REV-D1 (20261013128500) refuses any unauthorised reversal of a Food payment.
-- These detection and settlement tests need a reversal to EXIST, so the guard
-- is switched off for 52 and 53 (re-enabled at the end of 53) to stand in for
-- a reversal reaching the ledger by any route. The guard itself is tested,
-- switched on, in 55_policy_controls.sql.
ALTER TABLE public.general_ledger DISABLE TRIGGER food_guard_payment_reversal;

CREATE FUNCTION pg_temp.ref(p_order uuid) RETURNS text LANGUAGE sql AS $$
  SELECT 'FOODPAY-' || order_reference FROM public.food_orders WHERE id = p_order;
$$;
CREATE FUNCTION pg_temp.status(p_order uuid) RETURNS text LANGUAGE sql AS $$
  SELECT payment_status FROM public.food_orders WHERE id = p_order;
$$;
-- a paid order for pay_a (funded), returned with its total
CREATE FUNCTION pg_temp.paid_order(p_key text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  v := pg_temp.received_order('pay_a', p_key);
  PERFORM food_test.act_as(food_test.id('pay_a'));
  PERFORM public.food_pay_order(v);
  RESET ROLE;
  RETURN v;
END $$;

-- ── the failure mode exists: the employee can reverse a Food payment ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid, total numeric); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.paid_order('rev-k1');
UPDATE o SET total = (SELECT total_ugx FROM public.food_orders f WHERE f.id = o.id);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.wallet_transfer_reversal_status(pg_temp.ref((SELECT id FROM o)))->>'can_reverse')::boolean,
                    'REVX-01 the standard status function treats a Food payment as reversible by the employee');
SELECT food_test.ok((public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o)))->>'success')::boolean,
                    'REVX-02 ...and the standard reversal succeeds (existing behaviour, unchanged)');
RESET ROLE;
SELECT food_test.ok(pg_temp.avail('pay_a') = 100000 AND pg_temp.avail('coord') = 0,
                    'REVX-03 ...the money is back with the employee and gone from the coordinator');
SELECT food_test.ok(pg_temp.status((SELECT id FROM o)) = 'paid',
                    'REVX-04 confirmed gap: until a Food check runs, the order still reads paid');
-- the employee retries pay (e.g. a second tab): previously "already paid"
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'payment_reversed',
                    'REVX-05 a retry reports the reversal instead of "already paid"');
RESET ROLE;
SELECT food_test.ok(pg_temp.status((SELECT id FROM o)) = 'payment_reversed'
                    AND EXISTS (SELECT 1 FROM public.food_order_events WHERE order_id = (SELECT id FROM o)
                                  AND event_type = 'payment_reversed' AND note = 'reversal_posted')
                    AND EXISTS (SELECT 1 FROM public.food_audit WHERE entity_id = (SELECT id FROM o) AND action = 'payment_reversed'),
                    'REVX-06 ...the order becomes payment_reversed, with an event and an audit entry');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '22023',
                        'REVX-07 a reversed order is never silently paid again');
RESET ROLE;
SELECT food_test.ok(pg_temp.legs((SELECT id FROM o)) = 2, 'REVX-08 ...and no new Food posting was made');
ROLLBACK;

-- ── partial reversal: the coordinator had spent part of it ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000), (food_test.id('pay_b'), 0);
CREATE TEMP TABLE o (id uuid, total numeric); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.paid_order('rev-k2');
UPDATE o SET total = (SELECT total_ugx FROM public.food_orders f WHERE f.id = o.id);
SELECT pg_temp.peer_transfer('coord', 'pay_b', floor((SELECT total FROM o) / 2), 'rev-spend-1');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o)))->>'amount')::numeric < (SELECT total FROM o),
                    'REVX-09 the standard reversal returns only what is left (a partial reversal)');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_verify_payment((SELECT id FROM o))->>'status') = 'payment_reversed',
                    'REVX-10 a partial reversal also ends the paid status');
RESET ROLE;
ROLLBACK;

-- ── no false positives ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid, k text); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.paid_order('rev-k3'), 'reversed';
INSERT INTO o SELECT pg_temp.paid_order('rev-k4'), 'intact';
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o WHERE k = 'reversed')));
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_verify_payment((SELECT id FROM o WHERE k = 'intact'))->>'verified')::boolean,
                    'REVX-11 another order''s reversal does not touch this one (exact reference match)');
-- the coordinator (recipient) cannot reverse; standard rule
SELECT food_test.raises(format($$SELECT public.reverse_wallet_transfer(%L)$$, pg_temp.ref((SELECT id FROM o WHERE k = 'intact'))), 'P0001',
                        'REVX-12 the receiving coordinator cannot reverse a Food payment (standard rule)');
RESET ROLE;
ROLLBACK;

BEGIN;
-- once the coordinator has withdrawn, the standard reversal is closed; the order stays paid
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.paid_order('rev-k5');
INSERT INTO public.withdrawal_requests (user_id, amount, status, created_at)
VALUES (food_test.id('coord'), 1, 'pending', now() + interval '1 second');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.wallet_transfer_reversal_status(pg_temp.ref((SELECT id FROM o)))->>'state') = 'withdrawn',
                    'REVX-13 after the coordinator withdraws, the standard reversal is closed');
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'replayed')::boolean,
                    'REVX-14 ...and the order correctly stays paid');
RESET ROLE;
ROLLBACK;

-- ── the fixed idempotency key can never re-mark a reversed payment as paid ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.paid_order('rev-k6');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o)));
RESET ROLE;
-- simulate any future path that puts the order back to unpaid
UPDATE public.food_orders SET payment_status = 'pending_payment', paid_at = NULL WHERE id = (SELECT id FROM o);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), 'XX000',
                        'REVX-15 re-paying with the same key cannot reuse the reversed transaction');
RESET ROLE;
SELECT food_test.ok(pg_temp.status((SELECT id FROM o)) = 'pending_payment' AND pg_temp.legs((SELECT id FROM o)) = 2,
                    'REVX-16 ...nothing marked paid, nothing new posted');
ROLLBACK;

-- ── capped batch reconciliation ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid, k text); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.paid_order('rev-k7'), 'reversed';
INSERT INTO o SELECT pg_temp.paid_order('rev-k8'), 'intact';
INSERT INTO o SELECT pg_temp.paid_order('rev-k9'), 'intact';
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o WHERE k = 'reversed')));
SELECT food_test.raises($$SELECT public.food_reconcile_payments(10)$$, '42501', 'REVX-17 an employee cannot run reconciliation');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises($$SELECT public.food_reconcile_payments(0)$$, '22023', 'REVX-18 a batch size of 0 is refused');
SELECT food_test.raises($$SELECT public.food_reconcile_payments(501)$$, '22023', 'REVX-19 a batch above the cap is refused');
CREATE TEMP TABLE rr (n int, r jsonb); GRANT ALL ON rr TO authenticated;
INSERT INTO rr SELECT 1, public.food_reconcile_payments(1);
INSERT INTO rr SELECT 2, public.food_reconcile_payments(10);
SELECT food_test.ok((SELECT (r->>'checked')::int = 1 AND (r->>'more_pending')::boolean FROM rr WHERE n = 1),
                    'REVX-20 a capped batch checks only its limit and says more is pending');
SELECT food_test.ok((SELECT sum((r->>'reversed')::int) FROM rr) = 1,
                    'REVX-21 reconciliation finds exactly the one reversed payment');
RESET ROLE;
SELECT food_test.ok(pg_temp.status((SELECT id FROM o WHERE k = 'reversed')) = 'payment_reversed'
                    AND (SELECT bool_and(payment_status = 'paid' AND payment_verified_at IS NOT NULL)
                           FROM public.food_orders WHERE id IN (SELECT id FROM o WHERE k = 'intact')),
                    'REVX-22 ...and leaves intact payments paid and freshly verified');
ROLLBACK;

SELECT food_test.ok(NOT has_function_privilege('authenticated', 'public.food_payment_problem(public.food_orders)', 'EXECUTE')
                    AND NOT has_function_privilege('authenticated', 'public.food_mark_payment_reversed(uuid, uuid, jsonb, uuid)', 'EXECUTE'),
                    'REVX-23 the internal helpers are not callable by users');
