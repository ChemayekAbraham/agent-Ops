-- Shopping Advance x Food payments (pending fix
-- supabase/pending/food_m1/20261013128600_food_shopping_advance_exclusion.sql).
-- Runs after 49_advance_integration.sql in the same session. run.sh loads the
-- live _shopping_advance_received_24h (drizzle 0533, verbatim) and then the
-- pending fix. Everything is rolled back.
BEGIN;
SELECT food_test.ok(md5(prosrc) <> '29fa5640ca5bd977e7929684c95554c2', 'SA-00 the pending fix replaced the live definition')
  FROM pg_proc WHERE proname = '_shopping_advance_received_24h';
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000), (food_test.id('adv_peer'), 100000);
CREATE TEMP TABLE sa (id uuid); GRANT ALL ON sa TO authenticated, anon;
INSERT INTO sa SELECT pg_temp.received_order('pay_a', 'sa-k1');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM sa))->>'status') = 'paid', 'SA-01 a canteen wallet payment is made');
RESET ROLE;
CREATE TEMP TABLE payee AS SELECT payee_id AS id FROM public.food_orders WHERE id = (SELECT id FROM sa);
SELECT food_test.ok(EXISTS (SELECT 1 FROM public.general_ledger WHERE user_id = (SELECT id FROM payee)
                             AND direction = 'cash_in' AND category = 'wallet_transfer' AND reference_id LIKE 'FOODPAY-%'),
  'SA-02 ...posted as an ordinary wallet_transfer credit to the coordinator (unchanged)');
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM public._shopping_advance_received_24h() s WHERE s.user_id = (SELECT id FROM payee)),
  'SA-03 the Food payment does NOT make the coordinator a Shopping Advance received-transfer user');
-- a legitimate peer transfer to the same coordinator still counts, alone
SELECT pg_temp.peer_transfer('adv_peer', 'coord', 7000, 'sa-peer-1') WHERE (SELECT id FROM payee) = food_test.id('coord');
SELECT food_test.ok((SELECT transfer_count = 1 AND transfer_total = 7000 FROM public._shopping_advance_received_24h() s
                      WHERE s.user_id = food_test.id('coord')),
  'SA-04 a real transfer to the coordinator still counts, and only it (1 transfer, UGX 7,000)');
SELECT pg_temp.peer_transfer('adv_peer', 'pay_b', 5000, 'sa-peer-2');
SELECT food_test.ok((SELECT transfer_count = 1 AND transfer_total = 5000 FROM public._shopping_advance_received_24h() s
                      WHERE s.user_id = food_test.id('pay_b')),
  'SA-05 an ordinary transfer between other users is counted as before');
-- boundaries: outside 24h, admin corrections, float bucket scope, zero amount stay excluded as before
UPDATE public.general_ledger SET transaction_date = now() - interval '24 hours 1 minute' WHERE idempotency_key = 'sa-peer-2';
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM public._shopping_advance_received_24h() s WHERE s.user_id = food_test.id('pay_b')),
  'SA-06 a transfer older than 24 hours is not counted (unchanged)');
UPDATE public.general_ledger SET transaction_date = now() - interval '23 hours 59 minutes' WHERE idempotency_key = 'sa-peer-2';
SELECT food_test.ok(EXISTS (SELECT 1 FROM public._shopping_advance_received_24h() s WHERE s.user_id = food_test.id('pay_b')),
  'SA-07 a transfer just inside 24 hours is counted (unchanged)');
UPDATE public.general_ledger SET classification = 'admin_correction' WHERE idempotency_key = 'sa-peer-2';
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM public._shopping_advance_received_24h() s WHERE s.user_id = food_test.id('pay_b')),
  'SA-08 admin corrections are not counted (unchanged)');
-- a Food-referenced leg outside any recorded attempt (e.g. a reversal leg) is excluded
UPDATE public.general_ledger SET classification = 'production', reference_id = 'FOODPAY-X-REV' WHERE idempotency_key = 'sa-peer-2' AND direction = 'cash_in';
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM public._shopping_advance_received_24h() s WHERE s.user_id = food_test.id('pay_b')),
  'SA-09 a Food payment reversal credit is not counted as a received transfer');
-- the Food leg alone, if it were counted, would differ from the live rule: prove the live rule counted it
SELECT food_test.ok((SELECT count(*) FROM public.general_ledger gl WHERE gl.user_id = (SELECT id FROM payee)
                      AND gl.ledger_scope = 'wallet' AND gl.category = 'wallet_transfer' AND gl.direction = 'cash_in'
                      AND gl.amount > 0 AND gl.classification <> 'admin_correction'
                      AND gl.transaction_date >= now() - interval '24 hours') = 2,
  'SA-10 the live (unfixed) rule would have counted the Food payment: the defect is real');
ROLLBACK;
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = '_shopping_advance_received_24h'
                                 AND p.prosrc ~* '(insert|update|delete)\s'),
  'SA-11 the fixed function only reads');
