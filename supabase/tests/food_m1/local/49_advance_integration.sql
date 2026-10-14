-- Food payment x existing wallet gates and Agent Advance recovery (20261013128000).
-- Runs after 48_payment.sql in the same session (pay_a, pay_b, coord, wallets,
-- pg_temp.delivered_order). The sweep gate get_agent_sweepable_withdrawable is
-- the REPO definition (20260719161607), loaded verbatim by run.sh; the ledger
-- and get_user_available_balance are local stand-ins with the repo's shape.
-- Business rule: recovery is exactly as the existing rules permit; Food adds no
-- exemption, no protection and no recovery logic of its own.

INSERT INTO food_test.ids VALUES ('adv_peer', 'f0000000-0000-4000-8000-0000000000d9');
INSERT INTO auth.users (id, email) VALUES (food_test.id('adv_peer'), 'adv_peer@example.invalid');
INSERT INTO public.profiles (id, full_name, email) VALUES (food_test.id('adv_peer'), 'TEST ADV PEER', 'adv_peer@example.invalid');
INSERT INTO public.wallets_physical (user_id) VALUES (food_test.id('adv_peer'));

-- delivered and receipt-confirmed by the employee: ready to pay
CREATE FUNCTION pg_temp.received_order(p_employee text, p_key text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  v := pg_temp.delivered_order(p_employee, p_key);
  PERFORM food_test.act_as(food_test.id(p_employee));
  PERFORM public.food_confirm_receipt(v);
  RESET ROLE;
  RETURN v;
END $$;
-- an ordinary (non-Food) peer transfer, posted the way wallet-transfer posts it
CREATE FUNCTION pg_temp.peer_transfer(p_from text, p_to text, p_amount numeric, p_key text) RETURNS uuid LANGUAGE sql AS $$
  SELECT public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('user_id', food_test.id(p_from), 'amount', p_amount, 'direction', 'cash_out', 'category', 'wallet_transfer',
      'ledger_scope', 'wallet', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable', 'source_table', 'test_peer'),
    jsonb_build_object('user_id', food_test.id(p_to), 'amount', p_amount, 'direction', 'cash_in', 'category', 'wallet_transfer',
      'ledger_scope', 'wallet', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable', 'source_table', 'test_peer')), p_key);
$$;
CREATE FUNCTION pg_temp.legs(p_order uuid) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.general_ledger WHERE source_id = p_order;
$$;

-- ── 1. Wallet Ops controls: the same freeze wallet-transfer applies ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'adv-k1');
INSERT INTO public.treasury_controls (control_key, enabled) VALUES ('withdrawals_paused', true);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '55000', 'ADV-01 paused withdrawals stop a Food payment');
RESET ROLE;
UPDATE public.treasury_controls SET enabled = false WHERE control_key = 'withdrawals_paused';
INSERT INTO public.treasury_controls (control_key, enabled) VALUES ('maintenance_mode', true);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '55000', 'ADV-02 maintenance mode stops a Food payment');
RESET ROLE;
INSERT INTO public.treasury_controls (control_key, enabled, value) VALUES ('maintenance_until', true, 'not-a-time');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '55000', 'ADV-03 an unreadable maintenance end keeps the freeze on');
RESET ROLE;
SELECT food_test.ok(pg_temp.legs((SELECT id FROM o)) = 0
                    AND (SELECT payment_status FROM public.food_orders WHERE id = (SELECT id FROM o)) = 'pending_payment',
                    'ADV-04 ...nothing posted, the order stays unpaid');
UPDATE public.treasury_controls SET value = (now() - interval '1 minute')::text WHERE control_key = 'maintenance_until';
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'paid',
                    'ADV-05 once the maintenance window has ended, payment proceeds');
ROLLBACK;

-- ── 2. the canonical spendable figure (holds; advance lock while paused) ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'adv-k2');
INSERT INTO ledger_test.hold VALUES (food_test.id('pay_a'), 100000);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'reason') = 'insufficient_funds',
                    'ADV-06 a funder hold is not spendable on food');
RESET ROLE;
DELETE FROM ledger_test.hold;
INSERT INTO ledger_test.advance_locked VALUES (food_test.id('pay_a'), 100000);
INSERT INTO public.treasury_controls (control_key, enabled) VALUES ('advance_withdrawals_paused', true);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'reason') = 'insufficient_funds',
                    'ADV-07 advance-locked money cannot be spent on food while advance withdrawals are paused');
RESET ROLE;
SELECT food_test.ok(pg_temp.legs((SELECT id FROM o)) = 0, 'ADV-08 ...nothing posted for either refusal');
UPDATE public.treasury_controls SET enabled = false WHERE control_key = 'advance_withdrawals_paused';
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'paid',
                    'ADV-09 with the pause off the lock does not apply (existing rule, unchanged)');
ROLLBACK;

BEGIN;
-- the projection reads high but the ledger has nothing: the ledger still refuses
INSERT INTO ledger_test.avail_bonus VALUES (food_test.id('pay_a'), 1000000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'adv-k3');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'reason') = 'insufficient_funds',
                    'ADV-10 the ledger balance check stays the final word');
RESET ROLE;
SELECT food_test.ok(pg_temp.legs((SELECT id FROM o)) = 0, 'ADV-11 ...nothing posted');
ROLLBACK;

-- ── 3. recovery: the coordinator is treated exactly as any agent ──
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000), (food_test.id('pay_b'), 100000),
                                       (food_test.id('coord'), 100000), (food_test.id('adv_peer'), 100000);
INSERT INTO public.agent_advances (agent_id, status, outstanding_balance)
VALUES (food_test.id('coord'), 'active', 500000), (food_test.id('adv_peer'), 'active', 500000);
CREATE TEMP TABLE o (id uuid, total numeric); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.received_order('pay_a', 'adv-k4');
UPDATE o SET total = (SELECT total_ugx FROM public.food_orders f WHERE f.id = o.id);
CREATE TEMP TABLE before AS SELECT public.get_agent_sweepable_withdrawable(food_test.id('coord')) AS coord_sweep;
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.food_pay_order((SELECT id FROM o));
RESET ROLE;
-- an identical, ordinary peer transfer to another agent in arrears
SELECT pg_temp.peer_transfer('pay_b', 'adv_peer', (SELECT total FROM o), 'adv-peer-1');
SELECT food_test.ok(public.get_user_available_balance(food_test.id('coord')) = 100000 + (SELECT total FROM o),
                    'ADV-12 the payment reaches the coordinator''s wallet in full');
SELECT food_test.ok(public.get_agent_sweepable_withdrawable(food_test.id('coord')) = (SELECT coord_sweep FROM before),
                    'ADV-13 the food receipt is shielded only as the existing peer-transfer rule shields any transfer');
SELECT food_test.ok(public.get_agent_sweepable_withdrawable(food_test.id('coord')) = 100000,
                    'ADV-14 the coordinator''s other money stays fully recoverable: no exemption for the role');
SELECT food_test.ok(public.get_agent_sweepable_withdrawable(food_test.id('coord'))
                    = public.get_agent_sweepable_withdrawable(food_test.id('adv_peer')),
                    'ADV-15 a Food Coordinator and an ordinary agent receiving the same transfer are treated identically');
-- the coordinator spends: the shield is used up first, exactly as for any agent
SELECT pg_temp.peer_transfer('coord', 'pay_b', (SELECT total FROM o), 'adv-coord-out');
SELECT pg_temp.peer_transfer('adv_peer', 'pay_b', (SELECT total FROM o), 'adv-peer-out');
SELECT food_test.ok(public.get_agent_sweepable_withdrawable(food_test.id('coord')) = 100000
                    AND public.get_agent_sweepable_withdrawable(food_test.id('coord'))
                      = public.get_agent_sweepable_withdrawable(food_test.id('adv_peer')),
                    'ADV-16 once spent, the protection is gone for both alike');
SELECT food_test.ok((SELECT count(*) FROM public.agent_advances WHERE outstanding_balance = 500000 AND status = 'active') = 2,
                    'ADV-17 Food never touches advance balances or status');
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE source_table = 'food_orders'
                                  AND category <> 'wallet_transfer'),
                    'ADV-18 Food posts only ordinary wallet_transfer legs: no repayment or recovery postings');
ROLLBACK;

BEGIN;
-- without an active advance nothing is shielded or swept: the whole wallet is ordinary
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000), (food_test.id('coord'), 100000);
CREATE TEMP TABLE o (id uuid, total numeric); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.received_order('pay_a', 'adv-k5');
UPDATE o SET total = (SELECT total_ugx FROM public.food_orders f WHERE f.id = o.id);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.food_pay_order((SELECT id FROM o));
RESET ROLE;
SELECT food_test.ok(public.get_agent_sweepable_withdrawable(food_test.id('coord')) = 100000 + (SELECT total FROM o),
                    'ADV-19 a coordinator with no advance: the receipt is ordinary withdrawable money');
ROLLBACK;

BEGIN;
-- the payer is an agent in arrears: paying for food uses up their own shield first, like any spending
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000), (food_test.id('pay_b'), 100000);
INSERT INTO public.agent_advances (agent_id, status, outstanding_balance) VALUES (food_test.id('pay_a'), 'active', 500000);
SELECT pg_temp.peer_transfer('pay_b', 'pay_a', 50000, 'adv-in-1');
CREATE TEMP TABLE o (id uuid, total numeric); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.received_order('pay_a', 'adv-k6');
UPDATE o SET total = (SELECT total_ugx FROM public.food_orders f WHERE f.id = o.id);
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.food_pay_order((SELECT id FROM o));
RESET ROLE;
SELECT food_test.ok(public.get_agent_sweepable_withdrawable(food_test.id('pay_a'))
                    = GREATEST(0, public.get_user_available_balance(food_test.id('pay_a'))
                                  - GREATEST(0, 50000 - (SELECT total FROM o))),
                    'ADV-20 a payer in arrears: the food payment counts as ordinary spending under the existing rule');
ROLLBACK;

-- ── 4. no Food code reaches into advance recovery ──
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                 WHERE n.nspname = 'public' AND p.proname LIKE 'food\_%'
                                   AND p.prosrc ~* '(agent_advance|sweepable|advance_locked|agent_repayment)'),
                    'ADV-21 no food_* function references advance recovery objects');
