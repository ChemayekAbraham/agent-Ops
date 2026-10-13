-- Owner policy decisions (20261013128500), with the ledger guard ON:
-- REV-D1 canteen payments are not reversed (no reversal path at all);
-- HND-D1 another active coordinator takes over a blocked payment. Runs after 54_wallet_routing.sql in the same session
-- (pay_a, pay_b, coord, emp_ok; pg_temp.received_order, paid_order,
-- peer_transfer, legs, avail, ref, status, attempt, events, gl_rows, wallet_of).
-- The standard reversal is the repo definition (drizzle 0451/0453, verbatim).

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
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises(format($$SELECT public.reverse_wallet_transfer(%L)$$, pg_temp.ref((SELECT id FROM o))), 'P0001',
                        'P1-04 the receiving coordinator cannot reverse either (standard rule)');
RESET ROLE;
ROLLBACK;

SELECT food_test.ok(to_regprocedure('public.food_reverse_payment(uuid, text)') IS NULL
                    AND to_regclass('public.food_payment_reversals') IS NULL
                    AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                     WHERE n.nspname = 'public' AND p.proname LIKE 'food\_%'
                                       AND p.prosrc LIKE '%-REV%'
                                       AND p.proname NOT IN ('food_payment_problem', 'food_pay_order')),
                    'P1-05 Food has no reversal path at all: nothing in Food can post a reversal');

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

SELECT food_test.ok(NOT has_function_privilege('authenticated', 'public.food_payee_block_reason(uuid, uuid, uuid)', 'EXECUTE')
                    AND NOT has_function_privilege('authenticated', 'public.food_guard_payment_reversal()', 'EXECUTE'),
                    'POL-99 users cannot call the internal checks');
