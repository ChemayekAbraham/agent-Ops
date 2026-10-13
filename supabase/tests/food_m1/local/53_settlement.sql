-- Settlement model for Food payments (20261013128000): blocked recipients,
-- reversal records (full and partial), the authorised new-attempt path,
-- reference collisions and reconciliation. Runs after 52_reversal.sql in the
-- same session (pay_a, pay_b, coord, emp_ok; pg_temp.received_order,
-- paid_order, peer_transfer, legs, avail, ref, status, untouched). The
-- standard reversal is the repo definition (drizzle 0451/0453), loaded
-- verbatim by run.sh; nothing here is production evidence.

CREATE FUNCTION pg_temp.attempt(p_order uuid, p_no int) RETURNS public.food_payment_attempts LANGUAGE sql AS $$
  SELECT * FROM public.food_payment_attempts WHERE order_id = p_order AND attempt_no = p_no;
$$;
CREATE FUNCTION pg_temp.events(p_order uuid, p_type text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.food_order_events WHERE order_id = p_order AND event_type = p_type;
$$;
CREATE FUNCTION pg_temp.gl_rows() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM public.general_ledger $$;
-- a row a stranger could have posted, for collision tests (no money moves: test ledger only)
CREATE FUNCTION pg_temp.stray(p_ref text, p_key text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.general_ledger (transaction_group_id, user_id, amount, direction, category, ledger_scope,
                                     source_table, reference_id, idempotency_key)
  VALUES (gen_random_uuid(), food_test.id('pay_b'), 1, 'cash_in', 'wallet_transfer', 'wallet', 'test_stray', p_ref, p_key);
$$;
CREATE FUNCTION pg_temp.as_service() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
END $$;

-- ═══ blocked recipient: recorded, escalatable, payee never redirected ═══
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'set-b1');
UPDATE public.profiles SET is_frozen = true WHERE id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('pay_a'));
CREATE TEMP TABLE r AS SELECT public.food_pay_order((SELECT id FROM o)) AS v; GRANT ALL ON r TO authenticated;
RESET ROLE;
SELECT food_test.ok((SELECT v->>'status' = 'blocked' AND v->>'reason' = 'recipient_ineligible' AND (v->>'escalate')::boolean
                       AND v->>'detail' ILIKE '%frozen%' FROM r),
                    'BLK-01 an ineligible payee gives a clear, escalatable "blocked" result');
SELECT food_test.ok((SELECT payment_status = 'pending_payment' AND payment_resolution_required
                            AND payment_resolution_reason = 'recipient_ineligible' FROM public.food_orders WHERE id = (SELECT id FROM o))
                    AND pg_temp.events((SELECT id FROM o), 'payment_blocked') = 1
                    AND EXISTS (SELECT 1 FROM public.food_audit WHERE entity_id = (SELECT id FROM o) AND action = 'payment_blocked')
                    AND pg_temp.legs((SELECT id FROM o)) = 0,
                    'BLK-02 ...flagged for resolution, recorded and audited, nothing posted');
UPDATE public.profiles SET is_frozen = false WHERE id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'status') = 'paid',
                    'BLK-03 once the payee is eligible again, the employee''s retry pays');
RESET ROLE;
SELECT food_test.ok((SELECT NOT payment_resolution_required AND payment_resolution_reason IS NULL
                       FROM public.food_orders WHERE id = (SELECT id FROM o))
                    AND (SELECT count(*) FROM public.food_payment_attempts WHERE order_id = (SELECT id FROM o)) = 1
                    AND pg_temp.legs((SELECT id FROM o)) = 2,
                    'BLK-04 ...exactly one payment, the flag cleared');
ROLLBACK;

BEGIN;
-- handover after receipt: the snapshot payee is paid, the new coordinator receives nothing
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.received_order('pay_a', 'set-b2');
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_transfer_coordinator(food_test.id('emp_ok'), 'full_transfer', 'handover after receipt was confirmed');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.food_pay_order((SELECT id FROM o));
RESET ROLE;
SELECT food_test.ok((pg_temp.attempt((SELECT id FROM o), 1)).payee_id = food_test.id('coord')
                    AND pg_temp.avail('emp_ok') = 0
                    AND NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE user_id = food_test.id('emp_ok')),
                    'BLK-05 a handover never redirects the payment: the receipt-time coordinator is paid, the new one gets nothing');
ROLLBACK;

-- ═══ reversal records: history preserved, partial amounts kept, nothing automatic ═══
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid, total numeric, grp uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.paid_order('set-r1');
UPDATE o SET total = f.total_ugx, grp = f.transaction_group_id FROM public.food_orders f WHERE f.id = o.id;
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o)));
RESET ROLE;
CREATE TEMP TABLE b AS SELECT pg_temp.avail('pay_a') AS a, pg_temp.avail('coord') AS c, pg_temp.gl_rows() AS n;
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_verify_payment((SELECT id FROM o));
RESET ROLE;
SELECT food_test.ok((SELECT (x).state = 'reversed' AND (x).reversed_amount = (SELECT total FROM o)
                            AND (x).reversal_reference = pg_temp.ref((SELECT id FROM o)) || '-REV'
                            AND (x).reversal_posted_at IS NOT NULL AND (x).problem_detected_at IS NOT NULL
                            AND (x).transaction_group_id = (SELECT grp FROM o)
                       FROM (SELECT pg_temp.attempt((SELECT id FROM o), 1) AS x) y),
                    'SET-01 the attempt keeps its transaction, reference, and the reversal amount, reference and time');
SELECT food_test.ok((SELECT payment_status = 'payment_reversed' AND payment_resolution_required
                            AND transaction_group_id = (SELECT grp FROM o) AND paid_at IS NOT NULL
                       FROM public.food_orders WHERE id = (SELECT id FROM o)),
                    'SET-02 the order is reversed and flagged; its original transaction and paid time are kept');
SELECT food_test.ok(pg_temp.avail('pay_a') = (SELECT a FROM b) AND pg_temp.avail('coord') = (SELECT c FROM b)
                    AND pg_temp.gl_rows() = (SELECT n FROM b),
                    'SET-03 detection moves no money: no recharge, no repayment, no posting');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM o)), '22023',
                        'SET-04 the employee cannot simply pay again: it needs an authorised resolution');
RESET ROLE;
ROLLBACK;

BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000), (food_test.id('pay_b'), 0);
CREATE TEMP TABLE o (id uuid, total numeric); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.paid_order('set-r2');
UPDATE o SET total = (SELECT total_ugx FROM public.food_orders f WHERE f.id = o.id);
SELECT pg_temp.peer_transfer('coord', 'pay_b', floor((SELECT total FROM o) / 2), 'set-spend');
SELECT food_test.act_as(food_test.id('pay_a'));
CREATE TEMP TABLE rv AS SELECT (public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o)))->>'amount')::numeric AS amt;
GRANT ALL ON rv TO authenticated;
SELECT food_test.act_as(food_test.id('coord'));
CREATE TEMP TABLE r AS SELECT public.food_verify_payment((SELECT id FROM o)) AS v; GRANT ALL ON r TO authenticated;
RESET ROLE;
SELECT food_test.ok((SELECT (v->>'partial')::boolean AND (v->>'reversed_amount')::numeric = (SELECT amt FROM rv) FROM r)
                    AND (pg_temp.attempt((SELECT id FROM o), 1)).reversed_amount = (SELECT amt FROM rv)
                    AND (SELECT amt FROM rv) < (SELECT total FROM o),
                    'SET-05 a partial reversal is recorded as partial, with the amount actually returned');
ROLLBACK;

-- ═══ authorised new attempt ═══
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid, total numeric); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o (id) SELECT pg_temp.paid_order('set-t1');
UPDATE o SET total = (SELECT total_ugx FROM public.food_orders f WHERE f.id = o.id);
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises(format($$SELECT public.food_authorize_payment_retry(%L, 'customer asked to pay again')$$, (SELECT id FROM o)), '22023',
                        'RTY-01 a paid (not reversed) order cannot get a new attempt');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o)));
SELECT public.food_verify_payment((SELECT id FROM o));
SELECT food_test.raises(format($$SELECT public.food_authorize_payment_retry(%L, 'please let me pay again')$$, (SELECT id FROM o)), '42501',
                        'RTY-02 the employee cannot authorise their own new attempt');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises(format($$SELECT public.food_authorize_payment_retry(%L, '  short ')$$, (SELECT id FROM o)), '22023',
                        'RTY-03 a reason is required');
CREATE TEMP TABLE n AS SELECT pg_temp.gl_rows() AS c; GRANT ALL ON n TO authenticated;
SELECT food_test.ok((public.food_authorize_payment_retry((SELECT id FROM o), 'Employee reversed by mistake; agreed to pay again'))->>'attempt' = '2',
                    'RTY-04 the active coordinator opens attempt 2');
RESET ROLE;
SELECT food_test.ok((SELECT payment_status = 'pending_payment' AND payment_attempt = 2 AND payee_id = food_test.id('coord')
                            AND transaction_group_id IS NULL FROM public.food_orders WHERE id = (SELECT id FROM o))
                    AND pg_temp.gl_rows() = (SELECT c FROM n)
                    AND pg_temp.events((SELECT id FROM o), 'payment_retry_authorised') = 1
                    AND (pg_temp.attempt((SELECT id FROM o), 1)).state = 'reversed',
                    'RTY-05 ...nobody is charged, the payee is unchanged, attempt 1 stays on record as reversed');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'attempt') = '2',
                    'RTY-06 the employee pays attempt 2');
SELECT food_test.ok((public.food_pay_order((SELECT id FROM o))->>'replayed')::boolean,
                    'RTY-07 ...a repeat is a replay of attempt 2, not a third charge');
RESET ROLE;
SELECT food_test.ok((SELECT (x).reference = pg_temp.ref((SELECT id FROM o)) || '-A2'
                            AND (x).idempotency_key = 'food_order_payment:' || (SELECT id FROM o)::text || ':2'
                            AND (x).authorised_by = food_test.id('coord') AND (x).authorised_reason ILIKE '%agreed to pay again%'
                            AND (x).state = 'paid' AND (x).payee_id = food_test.id('coord')
                       FROM (SELECT pg_temp.attempt((SELECT id FROM o), 2) AS x) y)
                    AND pg_temp.legs((SELECT id FROM o)) = 4,
                    'RTY-08 attempt 2 has its own reference and key, and records who authorised it and why');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_verify_payment((SELECT id FROM o))->>'verified')::boolean,
                    'RTY-09 attempt 1''s reversal markers do not touch attempt 2');
SELECT food_test.raises(format($$SELECT public.food_authorize_payment_retry(%L, 'trying to open another one')$$, (SELECT id FROM o)), '22023',
                        'RTY-10 a paid attempt 2 cannot be followed by another attempt');
-- a reversal of attempt 2 is its own event
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o)) || '-A2');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_verify_payment((SELECT id FROM o))->>'status') = 'payment_reversed'
                    AND (pg_temp.attempt((SELECT id FROM o), 2)).state = 'reversed'
                    AND (pg_temp.attempt((SELECT id FROM o), 1)).reversed_amount = (SELECT total FROM o),
                    'RTY-11 reversing attempt 2 is detected on attempt 2; attempt 1''s record is untouched');
RESET ROLE;
ROLLBACK;

BEGIN;
-- a backup (no longer active) coordinator cannot authorise
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.paid_order('set-t2');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o)));
SELECT public.food_verify_payment((SELECT id FROM o));
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_transfer_coordinator(food_test.id('emp_ok'), 'transfer_with_backup', 'handover keeping backup access');
SELECT food_test.raises(format($$SELECT public.food_authorize_payment_retry(%L, 'backup trying to authorise')$$, (SELECT id FROM o)), '42501',
                        'RTY-12 a backup coordinator cannot authorise');
SELECT food_test.act_as(food_test.id('emp_ok'));
SELECT food_test.ok((public.food_authorize_payment_retry((SELECT id FROM o), 'new coordinator authorises the retry'))->>'payee_id'
                      = food_test.id('coord')::text,
                    'RTY-13 the new active coordinator can authorise; the payee stays the receipt-time coordinator');
RESET ROLE;
ROLLBACK;

-- ═══ collisions: unrelated, prefixed, suffixed and partial references ═══
BEGIN;
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.paid_order('set-c1');
SELECT pg_temp.stray(pg_temp.ref((SELECT id FROM o)) || '-REVIEW', NULL);
SELECT pg_temp.stray(pg_temp.ref((SELECT id FROM o)) || '-REV-2', NULL);
SELECT pg_temp.stray('X' || pg_temp.ref((SELECT id FROM o)) || '-REV', 'reversal:X' || pg_temp.ref((SELECT id FROM o)));
SELECT pg_temp.stray(pg_temp.ref((SELECT id FROM o)) || '-A2-REV', 'reversal:' || pg_temp.ref((SELECT id FROM o)) || '-A2');
SELECT pg_temp.stray(left(pg_temp.ref((SELECT id FROM o)), -1) || '-REV', 'reversal:' || left(pg_temp.ref((SELECT id FROM o)), -1));
SELECT pg_temp.stray(NULL, 'reversal:' || pg_temp.ref((SELECT id FROM o)) || ' ');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_verify_payment((SELECT id FROM o))->>'verified')::boolean,
                    'COL-01 suffixed (-REVIEW, -REV-2), prefixed (X…), later-attempt (-A2-REV), truncated and padded markers do not count');
RESET ROLE;
SELECT pg_temp.stray(NULL, 'reversal:' || pg_temp.ref((SELECT id FROM o)));
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_verify_payment((SELECT id FROM o))->>'status') = 'payment_reversed',
                    'COL-02 the exact reversal key alone is enough (both markers are honoured)');
RESET ROLE;
ROLLBACK;

-- ═══ reconciliation ═══
BEGIN;
-- mixed batch: intact, fully reversed, reversal blocked by a withdrawal
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid, k text); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.paid_order('set-m1'), 'intact';
INSERT INTO o SELECT pg_temp.paid_order('set-m2'), 'reversed';
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o WHERE k = 'reversed')));
RESET ROLE;
INSERT INTO o SELECT pg_temp.paid_order('set-m3'), 'withdrawn';
INSERT INTO public.withdrawal_requests (user_id, amount, status) VALUES (food_test.id('coord'), 1, 'pending');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT food_test.ok((public.wallet_transfer_reversal_status(pg_temp.ref((SELECT id FROM o WHERE k = 'withdrawn')))->>'can_reverse')::boolean = false,
                    'REC-01 after the coordinator withdraws, that payment can no longer be reversed (standard rule)');
RESET ROLE;
CREATE TEMP TABLE n AS SELECT pg_temp.gl_rows() AS c;
SELECT pg_temp.as_service();
CREATE TEMP TABLE rr (k int, v jsonb);
INSERT INTO rr SELECT 1, public.food_reconcile_payments(50);
INSERT INTO rr SELECT 2, public.food_reconcile_payments(50);
RESET ROLE;
SELECT set_config('request.jwt.claims', NULL, true);
SELECT food_test.ok((SELECT (v->>'checked')::int = 3 AND (v->>'reversed')::int = 1 FROM rr WHERE k = 1),
                    'REC-02 a scheduler (service_role) run checks the mixed batch and finds exactly the reversed one');
SELECT food_test.ok((SELECT (v->>'reversed')::int = 0 FROM rr WHERE k = 2)
                    AND pg_temp.events((SELECT id FROM o WHERE k = 'reversed'), 'payment_reversed') = 1,
                    'REC-03 running it again changes nothing and records nothing twice');
SELECT food_test.ok((SELECT actor_id IS NULL AND note ILIKE '%system reconciliation%' FROM public.food_order_events
                      WHERE order_id = (SELECT id FROM o WHERE k = 'reversed') AND event_type = 'payment_reversed')
                    AND EXISTS (SELECT 1 FROM public.food_audit WHERE entity_id = (SELECT id FROM o WHERE k = 'reversed')
                                  AND action = 'payment_reversed' AND actor_id IS NULL),
                    'REC-04 a system detection is recorded as such (no invented actor)');
SELECT food_test.ok(pg_temp.status((SELECT id FROM o WHERE k = 'intact')) = 'paid'
                    AND pg_temp.status((SELECT id FROM o WHERE k = 'withdrawn')) = 'paid'
                    AND pg_temp.gl_rows() = (SELECT c FROM n),
                    'REC-05 intact and withdrawn-before-reversal payments stay paid; reconciliation posts nothing');
-- only a payment_reversed record may lack an actor
SELECT food_test.raises($$INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
                          SELECT id, 'paid', 'pending_payment', 'paid', 'x', NULL FROM public.food_orders LIMIT 1$$, '23514',
                        'REC-06 any other event still requires an actor');
ROLLBACK;

BEGIN;
-- never overwrites a newer state: attempt 1 reversed, attempt 2 paid and intact
INSERT INTO ledger_test.opening VALUES (food_test.id('pay_a'), 100000);
CREATE TEMP TABLE o (id uuid); GRANT ALL ON o TO authenticated, anon;
INSERT INTO o SELECT pg_temp.paid_order('set-n1');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.reverse_wallet_transfer(pg_temp.ref((SELECT id FROM o)));
SELECT public.food_verify_payment((SELECT id FROM o));
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_authorize_payment_retry((SELECT id FROM o), 'agreed second attempt after reversal');
SELECT food_test.act_as(food_test.id('pay_a'));
SELECT public.food_pay_order((SELECT id FROM o));
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_reconcile_payments(50)->>'reversed')::int = 0
                    AND pg_temp.status((SELECT id FROM o)) = 'paid',
                    'REC-07 the old reversal never reverts the newer, intact attempt');
RESET ROLE;
SELECT food_test.ok(pg_temp.events((SELECT id FROM o), 'payment_reversed') = 1, 'REC-08 ...and records nothing new');
-- a stale check cannot overwrite: marking with attempt 1's group does nothing now
SELECT food_test.ok(NOT public.food_mark_payment_reversed((SELECT id FROM o), (pg_temp.attempt((SELECT id FROM o), 1)).transaction_group_id,
                                                          '{"problem":"reversal_posted"}'::jsonb, food_test.id('coord'))
                    AND pg_temp.status((SELECT id FROM o)) = 'paid',
                    'REC-09 a stale result for an earlier posting cannot change the current state');
ROLLBACK;

BEGIN;
-- permissions
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_transfer_coordinator(food_test.id('emp_ok'), 'transfer_with_backup', 'handover keeping backup access');
SELECT food_test.raises($$SELECT public.food_reconcile_payments(10)$$, '42501', 'REC-10 a backup coordinator cannot reconcile');
SELECT set_config('request.jwt.claims', '', true);
SELECT food_test.raises($$SELECT public.food_reconcile_payments(10)$$, '42501', 'REC-11 an empty claims setting is refused cleanly, not a crash');
SET LOCAL ROLE anon;
SELECT food_test.raises($$SELECT public.food_reconcile_payments(10)$$, '42501', 'REC-12 anonymous cannot reconcile');
RESET ROLE;
SELECT food_test.ok(NOT has_function_privilege('authenticated', 'public.food_payment_reference(text, integer)', 'EXECUTE')
                    AND NOT has_function_privilege('authenticated', 'public.food_payment_key(uuid, integer)', 'EXECUTE')
                    AND NOT has_table_privilege('authenticated', 'public.food_payment_attempts', 'INSERT')
                    AND NOT has_table_privilege('authenticated', 'public.food_payment_attempts', 'UPDATE')
                    AND NOT has_table_privilege('authenticated', 'public.food_payment_attempts', 'DELETE'),
                    'REC-13 users cannot write payment attempts or call the identity helpers');
ROLLBACK;

-- back on for every later suite (see 52_reversal.sql)
ALTER TABLE public.general_ledger ENABLE TRIGGER food_guard_payment_reversal;
