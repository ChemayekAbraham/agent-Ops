-- Owner policy decisions REV-D1, REV-D2, HND-D1 (20261013128500), with the
-- REV-D1 ledger guard ON. Runs after 54_wallet_routing.sql in the same session
-- (pay_a, pay_b, coord, emp_ok; pg_temp.received_order, paid_order,
-- peer_transfer, legs, avail, ref, status, attempt, events, gl_rows, wallet_of).
-- The standard reversal is the repo definition (drizzle 0451/0453, verbatim).

INSERT INTO food_test.ids VALUES ('fin_cfo', 'f0000000-0000-4000-8000-0000000000e9'),
                                 ('fin_off', 'f0000000-0000-4000-8000-0000000000ea');
INSERT INTO auth.users (id, email) SELECT id, k || '@example.invalid' FROM food_test.ids WHERE k IN ('fin_cfo','fin_off');
INSERT INTO public.profiles (id, full_name, email) SELECT id, 'TEST ' || upper(k), k || '@example.invalid'
  FROM food_test.ids WHERE k IN ('fin_cfo','fin_off');
INSERT INTO public.user_roles (user_id, role, enabled) VALUES (food_test.id('fin_cfo'), 'cfo', true),
                                                              (food_test.id('fin_off'), 'cfo', false);
SELECT food_test.ok((SELECT tgenabled = 'O' FROM pg_trigger WHERE tgname = 'food_guard_payment_reversal'),
                    'POL-00 the REV-D1 guard is on for this suite');

-- ═══ REV-D1: no unauthorised reversal, by any route ═══
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid, total numeric); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.paid_order('pol-r1');
UPDATE o SET total = (SELECT total_ugx FROM public.food_orders f WHERE f.id = o.id);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.reverse_wallet_transfer(%L)$$, pg_temp.ref((SELECT id FROM o))), '42501',
                        'P1-01 the employee''s standard Reverse is refused for a canteen payment');
RESET ROLE;
SELECT food_test.ok(pg_temp.status((SELECT id FROM o)) = 'paid' AND pg_temp.legs((SELECT id FROM o)) = 2
                    AND pg_temp.avail('pay_a') = 100000 - (SELECT total FROM o) AND pg_temp.avail('coord') = (SELECT total FROM o)
                    AND NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = pg_temp.ref((SELECT id FROM o)) || '-REV'),
                    'P1-02 ...nothing posted, both wallets unchanged, the order stays paid');
SELECT food_test.raises(format($$SELECT public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('user_id', %L::uuid, 'amount', 1, 'direction', 'cash_out', 'category', 'wallet_transfer', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable', 'source_table', 'x', 'reference_id', %L),
    jsonb_build_object('user_id', %L::uuid, 'amount', 1, 'direction', 'cash_in', 'category', 'wallet_transfer', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable', 'source_table', 'x', 'reference_id', %L)), 'x-key')$$,
    food_test.id('coord'), pg_temp.ref((SELECT id FROM o)) || '-REV', food_test.id('pay_a'), pg_temp.ref((SELECT id FROM o)) || '-REV'),
  '42501', 'P1-03 any other route that tries to post a canteen reversal is refused by the ledger guard');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_reverse_payment(%L, 'I would like my money back')$$, (SELECT id FROM o)), '42501',
                        'P1-04 the employee cannot use the authorised reversal');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises(format($$SELECT public.food_reverse_payment(%L, 'coordinator returning it')$$, (SELECT id FROM o)), '42501',
                        'P1-05 the coordinator (or any non-finance user) cannot either');
SELECT food_test.act_as(food_test.id('pay_b'));
SELECT food_test.raises(format($$SELECT public.food_reverse_payment(%L, 'unrelated employee trying')$$, (SELECT id FROM o)), '42501',
                        'P1-05b an employee who is not a party and not a finance reviewer cannot');
SELECT food_test.act_as(food_test.id('fin_off'));
SELECT food_test.raises(format($$SELECT public.food_reverse_payment(%L, 'disabled reviewer trying')$$, (SELECT id FROM o)), '42501',
                        'P1-06 a disabled finance role cannot');
SELECT food_test.act_as(food_test.id('fin_cfo'));
SELECT food_test.raises(format($$SELECT public.food_reverse_payment(%L, 'short')$$, (SELECT id FROM o)), '22023',
                        'P1-07 a reason is mandatory');
CREATE TEMP TABLE r AS SELECT public.food_reverse_payment((SELECT id FROM o), 'Meal was not delivered; refund agreed with coordinator') AS v;
GRANT ALL ON r TO authenticated;
RESET ROLE;
SELECT food_test.ok((SELECT v->>'status' = 'reversed' FROM r)
                    AND pg_temp.avail('pay_a') = 100000 AND pg_temp.avail('coord') = 0,
                    'P1-08 an authorised finance reviewer reverses it: the money returns to the employee''s wallet');
SELECT food_test.ok((SELECT count(*) = 2
                            AND bool_and(reference_id = pg_temp.ref((SELECT id FROM o)) || '-REV'
                                         AND idempotency_key = 'reversal:' || pg_temp.ref((SELECT id FROM o)))
                            AND count(*) FILTER (WHERE direction = 'cash_out' AND wallet_id = pg_temp.wallet_of('coord')) = 1
                            AND count(*) FILTER (WHERE direction = 'cash_in'  AND wallet_id = pg_temp.wallet_of('pay_a')) = 1
                       FROM public.general_ledger WHERE transaction_group_id = (SELECT (v->>'transaction_group_id')::uuid FROM r)),
                    'P1-09 the reversal legs use the standard markers and the original wallets');
SELECT food_test.ok((SELECT state = 'posted' AND authorised_by = food_test.id('fin_cfo') AND amount = (SELECT total FROM o)
                            AND reason ILIKE '%not delivered%' AND transaction_group_id IS NOT NULL AND completed_at IS NOT NULL
                       FROM public.food_payment_reversals WHERE order_id = (SELECT id FROM o))
                    AND pg_temp.status((SELECT id FROM o)) = 'payment_reversed'
                    AND (pg_temp.attempt((SELECT id FROM o), 1)).state = 'reversed'
                    AND (pg_temp.attempt((SELECT id FROM o), 1)).reversed_amount = (SELECT total FROM o)
                    AND pg_temp.events((SELECT id FROM o), 'payment_reversal_authorised') = 1
                    AND EXISTS (SELECT 1 FROM public.food_audit WHERE entity_id = (SELECT id FROM o)
                                  AND action = 'payment_reversal_authorised' AND actor_id = food_test.id('fin_cfo')),
                    'P1-10 authorisation, reason, amount and outcome are recorded and audited');
SELECT food_test.act_as(food_test.id('fin_cfo'));
SELECT food_test.raises(format($$SELECT public.food_reverse_payment(%L, 'reversing a second time')$$, (SELECT id FROM o)), '22023',
                        'P1-11 a payment cannot be reversed twice');
-- ═══ REV-D2: no automatic recharge; retry only by authorised decision ═══
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '22023',
                        'P2-01 after a reversal the employee is not charged again without a decision');
SELECT food_test.act_as(food_test.id('coord'));
CREATE TEMP TABLE n AS SELECT pg_temp.gl_rows() AS c; GRANT ALL ON n TO authenticated;
SELECT public.food_reconcile_payments(50);
SELECT food_test.ok(pg_temp.gl_rows() = (SELECT c FROM n) AND pg_temp.status((SELECT id FROM o)) = 'payment_reversed',
                    'P2-02 reconciliation after a reversal charges nobody and changes nothing');
SELECT public.food_authorize_payment_retry((SELECT id FROM o), 'Employee agreed to pay again for the meal');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'attempt') = '2'
                    AND (public.food_pay_order((SELECT id FROM o))->>'replayed')::boolean,
                    'P2-03 after the authorised decision the employee pays once; a repeat is a replay');
RESET ROLE;
SELECT food_test.ok(pg_temp.legs((SELECT id FROM o)) = 6
                    AND (SELECT count(*) FROM public.food_payment_attempts WHERE order_id = (SELECT id FROM o)) = 2,
                    'P2-04 exactly: one payment, one reversal, one new payment');
ROLLBACK;

BEGIN;
-- the reviewer may not be a party to the payment
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.paid_order('pol-r2');
INSERT INTO public.user_roles (user_id, role, enabled) VALUES (food_test.id('pay_a'), 'cfo', true);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_reverse_payment(%L, 'reversing my own payment')$$, (SELECT id FROM o)), '42501',
                        'P1-12 a finance reviewer cannot reverse a payment they made');
RESET ROLE;
ROLLBACK;

BEGIN;
-- the coordinator no longer holds the money: refused, recorded, nothing posted
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000), (food_test.id('pay_b'), 0);
CREATE TEMP TABLE o (id uuid, total numeric); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.paid_order('pol-r3');
UPDATE o SET total = (SELECT total_ugx FROM public.food_orders f WHERE f.id = o.id);
SELECT pg_temp.peer_transfer('coord', 'pay_b', (SELECT total FROM o), 'pol-spend');
SELECT food_test.act_as(food_test.id('fin_cfo'));
SELECT food_test.ok((public.food_reverse_payment((SELECT id FROM o), 'Refund requested after complaint'))->>'status' = 'refused',
                    'P1-13 a reversal the coordinator cannot fund is refused');
RESET ROLE;
SELECT food_test.ok((SELECT state = 'refused' AND refusal_reason = 'coordinator_insufficient_funds'
                       FROM public.food_payment_reversals WHERE order_id = (SELECT id FROM o))
                    AND pg_temp.events((SELECT id FROM o), 'payment_reversal_refused') = 1
                    AND pg_temp.status((SELECT id FROM o)) = 'paid'
                    AND NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = pg_temp.ref((SELECT id FROM o)) || '-REV'),
                    'P1-14 ...recorded with its outcome; nothing posted; the order stays paid');
ROLLBACK;

-- ═══ HND-D1: another active coordinator takes over a blocked payment ═══
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'pol-h1');
CREATE TEMP TABLE o2 (id uuid); GRANT ALL ON o2 TO authenticated, anon;
INSERT INTO o2 SELECT pg_temp.received_order('pay_a', 'pol-h2');
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_transfer_coordinator(food_test.id('emp_ok'), 'full_transfer', 'handover to the new coordinator');
RESET ROLE;
UPDATE public.profiles SET is_frozen = true WHERE id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'blocked', 'P4-00 the frozen receipt-time coordinator blocks payment');
SELECT food_test.raises(format($$SELECT public.food_resolve_blocked_payment(%L, 'please pay someone else')$$, (SELECT id FROM o)), '42501',
                        'P4-01 the employee cannot redirect their own payment');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises(format($$SELECT public.food_resolve_blocked_payment(%L, 'taking it back myself')$$, (SELECT id FROM o)), '42501',
                        'P4-02 the blocked (no longer active) coordinator cannot resolve it');
SELECT food_test.act_as(food_test.id('emp_ok'));
SELECT food_test.raises(format($$SELECT public.food_resolve_blocked_payment(%L, '  ')$$, (SELECT id FROM o)), '22023',
                        'P4-03 a reason is mandatory');
SELECT food_test.raises(format($$SELECT public.food_resolve_blocked_payment(%L, 'not blocked, should be refused')$$, (SELECT id FROM o2)), '22023',
                        'P4-04 an order that is not blocked cannot be reassigned');
RESET ROLE;
UPDATE public.profiles SET is_frozen = false WHERE id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('emp_ok'));
SELECT food_test.raises(format($$SELECT public.food_resolve_blocked_payment(%L, 'coordinator was frozen last week')$$, (SELECT id FROM o)), '22023',
                        'P4-05 a payee who can be paid again is never displaced');
RESET ROLE;
UPDATE public.profiles SET is_frozen = true WHERE id = food_test.id('coord');
CREATE TEMP TABLE n AS SELECT pg_temp.gl_rows() AS c; GRANT ALL ON n TO authenticated;
SELECT food_test.act_as(food_test.id('emp_ok'));
CREATE TEMP TABLE r AS SELECT public.food_resolve_blocked_payment((SELECT id FROM o), 'Previous coordinator frozen; I delivered and will receive payment') AS v;
GRANT ALL ON r TO authenticated;
RESET ROLE;
SELECT food_test.ok((SELECT payee_id = food_test.id('emp_ok') AND payee_wallet_id = pg_temp.wallet_of('emp_ok')
                            AND payee_name IS NOT NULL AND NOT payment_resolution_required AND payment_status = 'pending_payment'
                       FROM public.food_orders WHERE id = (SELECT id FROM o))
                    AND (SELECT v->>'previous_payee_blocked_because' = 'account frozen' FROM r),
                    'P4-06 another active coordinator takes over: their wallet and name are recorded');
SELECT food_test.ok(pg_temp.events((SELECT id FROM o), 'payee_reassigned') = 1
                    AND EXISTS (SELECT 1 FROM public.food_audit WHERE entity_id = (SELECT id FROM o) AND action = 'payee_reassigned'
                                  AND actor_id = food_test.id('emp_ok') AND reason ILIKE '%frozen%'
                                  AND before_val->>'payee_id' = food_test.id('coord')::text)
                    AND pg_temp.gl_rows() = (SELECT c FROM n),
                    'P4-07 the handover is recorded with its reason and both payees; no payment is made or retried');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'payee_wallet_id')::uuid = pg_temp.wallet_of('emp_ok'),
                    'P4-08 when the employee pays, it lands on the new coordinator''s wallet');
RESET ROLE;
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE user_id = food_test.id('coord') AND source_id = (SELECT id FROM o))
                    AND pg_temp.legs((SELECT id FROM o)) = 2,
                    'P4-09 the frozen coordinator received nothing; exactly one payment');
ROLLBACK;

BEGIN;
-- the new payee must be payable: no wallet, frozen, or a remapped wallet are all refused
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'pol-h3');
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_transfer_coordinator(food_test.id('emp_ok'), 'full_transfer', 'handover to the new coordinator');
RESET ROLE;
-- block through an incorrectly mapped wallet: the recorded wallet changed owner
UPDATE public.wallets_physical SET user_id = food_test.id('wal_other') WHERE user_id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'blocked', 'P4-10 an incorrectly mapped wallet blocks payment');
RESET ROLE;
UPDATE public.profiles SET is_frozen = true WHERE id = food_test.id('emp_ok');
SELECT food_test.act_as(food_test.id('emp_ok'));
SELECT food_test.raises(format($$SELECT public.food_resolve_blocked_payment(%L, 'frozen coordinator trying')$$, (SELECT id FROM o)), '22023',
                        'P4-11 a frozen coordinator cannot take the payment over');
RESET ROLE;
UPDATE public.profiles SET is_frozen = false WHERE id = food_test.id('emp_ok');
DELETE FROM public.wallets_physical WHERE user_id = food_test.id('emp_ok');
SELECT food_test.act_as(food_test.id('emp_ok'));
SELECT food_test.raises(format($$SELECT public.food_resolve_blocked_payment(%L, 'coordinator without a wallet')$$, (SELECT id FROM o)), '22023',
                        'P4-12 a coordinator without a wallet cannot take the payment over');
RESET ROLE;
ROLLBACK;

SELECT food_test.ok(NOT has_function_privilege('authenticated', 'public.food_can_authorise_payment_reversal(uuid)', 'EXECUTE')
                    AND NOT has_function_privilege('authenticated', 'public.food_payee_block_reason(uuid, uuid, uuid)', 'EXECUTE')
                    AND NOT has_table_privilege('authenticated', 'public.food_payment_reversals', 'INSERT')
                    AND NOT has_table_privilege('authenticated', 'public.food_payment_reversals', 'UPDATE'),
                    'POL-99 users cannot write reversal records or call the internal checks');
