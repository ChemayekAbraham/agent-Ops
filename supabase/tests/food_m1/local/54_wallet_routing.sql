-- Food payments are routed by the coordinator's WALLET recorded at receipt
-- (20261013128000). Runs after 53_settlement.sql in the same session (pay_a,
-- coord; pg_temp.received_order, paid_order, legs, status). The ledger here is
-- the local stand-in, which resolves general_ledger.wallet_id from
-- public.wallets by user_id exactly as the repo create_ledger_transaction
-- (20260914180000) does; wallets.id is wallets_physical.id as in the repo view.

INSERT INTO food_test.ids VALUES ('wal_other', 'f0000000-0000-4000-8000-0000000000d7');
INSERT INTO auth.users (id, email) VALUES (food_test.id('wal_other'), 'wal_other@example.invalid');
INSERT INTO public.profiles (id, full_name, email) VALUES (food_test.id('wal_other'), 'TEST WAL OTHER', 'wal_other@example.invalid');

CREATE FUNCTION pg_temp.wallet_of(p text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.wallets_physical WHERE user_id = food_test.id(p);
$$;

-- ── the wallet and name are recorded at receipt, and the payment lands on that wallet ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.delivered_order('pay_a', 'wal-k1');
SELECT food_test.act_as(food_test.id('pay_a'));
CREATE TEMP TABLE c AS SELECT public.food_confirm_receipt((SELECT id FROM o)) AS v; GRANT ALL ON c TO authenticated;
RESET ROLE;
SELECT food_test.ok((SELECT (v->>'payee_wallet_id')::uuid = pg_temp.wallet_of('coord')
                            AND v->>'payee_name' = (SELECT full_name FROM public.profiles WHERE id = food_test.id('coord')) FROM c)
                    AND (SELECT payee_wallet_id = pg_temp.wallet_of('coord') AND payee_name IS NOT NULL
                           FROM public.food_orders WHERE id = (SELECT id FROM o)),
                    'WAL-01 receipt records the coordinator''s wallet id and name, and shows them');
SELECT food_test.act_as(food_test.id('pay_a'));
CREATE TEMP TABLE r AS SELECT public.food_pay_order((SELECT id FROM o)) AS v; GRANT ALL ON r TO authenticated;
RESET ROLE;
SELECT food_test.ok((SELECT wallet_id FROM public.general_ledger WHERE source_id = (SELECT id FROM o) AND direction = 'cash_in')
                      = pg_temp.wallet_of('coord')
                    AND (SELECT wallet_id FROM public.general_ledger WHERE source_id = (SELECT id FROM o) AND direction = 'cash_out')
                      = pg_temp.wallet_of('pay_a'),
                    'WAL-02 the credit lands on the recorded coordinator wallet; the debit on the employee''s wallet');
SELECT food_test.ok((SELECT (v->>'payee_wallet_id')::uuid = pg_temp.wallet_of('coord') AND v->>'payee_name' IS NOT NULL FROM r)
                    AND (SELECT payee_wallet_id = pg_temp.wallet_of('coord') AND payer_wallet_id = pg_temp.wallet_of('pay_a')
                                AND payee_name IS NOT NULL
                           FROM public.food_payment_attempts WHERE order_id = (SELECT id FROM o)),
                    'WAL-03 the payment result and the permanent record show the wallet ids and the name');
ROLLBACK;

-- ── the recorded wallet no longer belongs to the coordinator: blocked, nothing posted ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'wal-k2');
UPDATE public.wallets_physical SET user_id = food_test.id('wal_other') WHERE user_id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('pay_a'));
CREATE TEMP TABLE r AS SELECT public.food_pay_order((SELECT id FROM o)) AS v; GRANT ALL ON r TO authenticated;
RESET ROLE;
SELECT food_test.ok((SELECT v->>'status' = 'blocked' AND v->>'detail' ILIKE '%no longer belongs%' FROM r)
                    AND pg_temp.legs((SELECT id FROM o)) = 0
                    AND NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE user_id = food_test.id('wal_other')),
                    'WAL-04 a recorded wallet that changed owner is never paid: blocked, nothing posted, the new owner gets nothing');
ROLLBACK;

-- ── no wallet at receipt: recorded when it exists at payment time ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE w AS SELECT id, user_id FROM public.wallets_physical WHERE user_id = food_test.id('coord');
GRANT ALL ON w TO authenticated;
DELETE FROM public.wallets_physical WHERE user_id = food_test.id('coord');
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'wal-k3');
SELECT food_test.ok((SELECT payee_wallet_id IS NULL FROM public.food_orders WHERE id = (SELECT id FROM o)),
                    'WAL-05 a coordinator without a wallet at receipt is recorded without one');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), 'P0002',
                        'WAL-06 ...and cannot be paid until they have a wallet');
RESET ROLE;
INSERT INTO public.wallets_physical (id, user_id) SELECT id, user_id FROM w;
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'payee_wallet_id')::uuid = (SELECT id FROM w),
                    'WAL-07 once the wallet exists it is recorded and paid');
RESET ROLE;
ROLLBACK;

-- ── the ledger must record the expected wallets, or nothing counts as paid ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'wal-k4');
UPDATE ledger_test.mode SET m = 'nowallet';
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), 'XX000',
                        'WAL-08 a credit recorded without the coordinator''s wallet id is refused');
RESET ROLE;
UPDATE ledger_test.mode SET m = 'normal';
SELECT food_test.ok(pg_temp.status((SELECT id FROM o)) = 'pending_payment'
                    AND NOT EXISTS (SELECT 1 FROM public.food_payment_attempts WHERE order_id = (SELECT id FROM o)),
                    'WAL-09 ...the order stays unpaid and no attempt is recorded');
ROLLBACK;

BEGIN;
-- a leg later found on a different wallet than the one recorded is not a valid payment
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.paid_order('wal-k5');
UPDATE public.general_ledger SET wallet_id = gen_random_uuid()
 WHERE source_id = (SELECT id FROM o) AND direction = 'cash_in';
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_verify_payment((SELECT id FROM o))->>'problem') = 'ledger_legs_do_not_match',
                    'WAL-10 verification flags a credit that is not on the recorded coordinator wallet');
RESET ROLE;
ROLLBACK;
