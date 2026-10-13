-- Recipient eligibility on the Food payment path (20261013128000).
-- Runs after 49_advance_integration.sql in the same session (pay_a, coord,
-- emp_ok, wallets, pg_temp.delivered_order / received_order / legs).
-- check_transfer_recipient_eligibility is the definition from
-- drizzle/migrations/0045, loaded verbatim by run.sh: these tests prove Food
-- calls the shared gate and honours its answer; they do not prove the live
-- function's body, which has not been read in production.

-- available balance of a test identity (read as the owner; the function is not granted to users)
CREATE FUNCTION pg_temp.avail(p text) RETURNS numeric LANGUAGE sql AS $$
  SELECT public.get_user_available_balance(food_test.id(p));
$$;
-- everything a refusal must leave untouched for one order
CREATE FUNCTION pg_temp.untouched(p_order uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT pg_temp.legs(p_order) = 0
     AND NOT EXISTS (SELECT 1 FROM public.food_order_events WHERE order_id = p_order AND event_type = 'paid')
     AND (SELECT payment_status = 'pending_payment' AND transaction_group_id IS NULL AND paid_at IS NULL
            FROM public.food_orders WHERE id = p_order);
$$;

-- ── eligible coordinator: the approved path still pays ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000), (food_test.id('coord'), 0);
CREATE TEMP TABLE o (id uuid, total numeric); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.received_order('pay_a', 'elig-k1');
UPDATE o SET total = (SELECT total_ugx FROM public.food_orders f WHERE f.id = o.id);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'paid',
                    'ELIG-01 an eligible coordinator is paid');
RESET ROLE;
SELECT food_test.ok(pg_temp.avail('pay_a') = 100000 - (SELECT total FROM o)
                    AND pg_temp.avail('coord') = (SELECT total FROM o) AND pg_temp.legs((SELECT id FROM o)) = 2,
                    'ELIG-02 ...employee debited, coordinator credited, exactly two legs');
ROLLBACK;

-- ── frozen coordinator (also what the fraud-blocking tool does) ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000), (food_test.id('coord'), 0);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'elig-k2');
UPDATE public.profiles SET is_frozen = true WHERE id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'blocked',
                    'ELIG-03 a frozen coordinator cannot be paid (blocked, nothing posted)');
RESET ROLE;
SELECT food_test.ok(pg_temp.untouched((SELECT id FROM o)) AND pg_temp.avail('pay_a') = 100000 AND pg_temp.avail('coord') = 0,
                    'ELIG-04 ...no ledger legs, no paid event, neither wallet changed');
-- duplicate and repeated requests after the refusal: still refused, still nothing posted
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'blocked',
                    'ELIG-05 a repeated request is refused the same way (blocked, nothing posted)');
RESET ROLE;
SELECT food_test.ok(pg_temp.untouched((SELECT id FROM o)), 'ELIG-06 ...and still posts nothing');
-- once the account is unfrozen the same order pays exactly once
UPDATE public.profiles SET is_frozen = false WHERE id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'replayed') = 'false',
                    'ELIG-07a after unfreezing, the same order pays');
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'replayed') = 'true',
                    'ELIG-07b ...and a repeat is a replay, not a second charge');
RESET ROLE;
SELECT food_test.ok(pg_temp.legs((SELECT id FROM o)) = 2, 'ELIG-08 ...exactly one posting');
ROLLBACK;

BEGIN;
-- fraud block through the standard tool: fraud_block_user_identifiers (20260706131556:143)
-- sets profiles.is_frozen, which is what the shared gate reads
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'elig-k3');
UPDATE public.profiles SET is_frozen = true WHERE id = food_test.id('coord');   -- as the fraud tool does
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'blocked',
                    'ELIG-09 a fraud-blocked (and therefore frozen) coordinator cannot be paid (blocked, nothing posted)');
RESET ROLE;
SELECT food_test.ok(pg_temp.untouched((SELECT id FROM o)), 'ELIG-10 ...nothing posted');
ROLLBACK;

-- ── closed (deleted) account ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'elig-k4');
UPDATE public.profiles SET deleted_at = now() WHERE id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'blocked',
                    'ELIG-11 a coordinator with a closed account cannot be paid (blocked, nothing posted)');
SELECT food_test.ok((SELECT reason FROM public.check_transfer_recipient_eligibility(food_test.id('coord'), NULL, food_test.id('pay_a'))) ILIKE '%closed%',
                    'ELIG-12 ...the shared gate refuses it too (same rule, both paths)');
RESET ROLE;
SELECT food_test.ok(pg_temp.untouched((SELECT id FROM o)), 'ELIG-13 ...nothing posted');
ROLLBACK;

-- ── self-transfer: the coordinator ordered for themselves ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('coord'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('coord', 'elig-k5');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '42501',
                        'ELIG-14 nobody can pay themselves');
SELECT food_test.ok((SELECT reason FROM public.check_transfer_recipient_eligibility(food_test.id('coord'), NULL, food_test.id('coord'))) ILIKE '%yourself%',
                    'ELIG-15 ...consistent with the shared gate');
RESET ROLE;
SELECT food_test.ok(pg_temp.untouched((SELECT id FROM o)), 'ELIG-16 ...nothing posted');
ROLLBACK;

-- ── no longer staff, or employee role disabled ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'elig-k6');
UPDATE public.user_roles SET enabled = false WHERE user_id = food_test.id('coord') AND role = 'employee';
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'blocked',
                    'ELIG-17 a coordinator whose staff role is disabled cannot be paid (blocked, nothing posted)');
RESET ROLE;
DELETE FROM public.user_roles WHERE user_id = food_test.id('coord') AND role = 'employee';
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'blocked',
                    'ELIG-18 a coordinator who is no longer staff cannot be paid (blocked, nothing posted)');
RESET ROLE;
SELECT food_test.ok(pg_temp.untouched((SELECT id FROM o)), 'ELIG-19 ...nothing posted');
ROLLBACK;

-- ── handover after receipt: the snapshot payee must still be eligible at payment time ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'elig-k7');
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_transfer_coordinator(food_test.id('emp_ok'), 'full_transfer', 'handover after receipt was confirmed');
RESET ROLE;
UPDATE public.profiles SET is_frozen = true WHERE id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'blocked',
                    'ELIG-20 after a handover, a payee who has become ineligible is not paid (blocked, nothing posted)');
RESET ROLE;
SELECT food_test.ok(pg_temp.untouched((SELECT id FROM o)), 'ELIG-21 ...nothing posted');
ROLLBACK;

-- ── fail closed if the shared gate is missing or its contract changed ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'elig-k8');
DROP FUNCTION public.check_transfer_recipient_eligibility(uuid, text, uuid);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '42883',
                        'ELIG-22 without the shared gate the payment is refused, never posted unchecked');
RESET ROLE;
SELECT food_test.ok(pg_temp.untouched((SELECT id FROM o)), 'ELIG-23 ...nothing posted');
ROLLBACK;

SELECT food_test.ok((SELECT prosrc ~ 'check_transfer_recipient_eligibility\(\s*p_recipient_id\s*=>\s*v_o\.payee_id,\s*p_item\s*=>\s*NULL::text,\s*p_sender_id\s*=>\s*v_uid\)'
                       FROM pg_proc WHERE proname = 'food_pay_order'),
                    'ELIG-24 the gate is called by name with the wallet-transfer arguments (recipient, no item, sender = payer)');
