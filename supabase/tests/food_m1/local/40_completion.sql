-- Completion work: FM-17 bootstrap, FM-21 exceptions, FM-23 no temp table,
-- FM-26f canteen self-check, and money isolation for every payment mode.
-- Runs in the same session as 10_behaviour.sql.

-- ─────────── FM-21: raising exceptions ───────────
BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
CREATE TEMP TABLE t_eo ON COMMIT DROP AS
  SELECT (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi'), 'quantity', 1)),'k-exc','cash')->>'order_id')::uuid AS id;
SELECT food_test.raises($$SELECT public.food_raise_exception('MISSING_ITEM', 'no sauce')$$, '22023', 'EXR-01 employee must name their order');
SELECT food_test.raises(format($$SELECT public.food_raise_exception('refund_me', 'x', %L)$$, (SELECT id FROM t_eo)), '22023', 'EXR-02 unknown kind refused');
SELECT food_test.raises(format($$SELECT public.food_raise_exception('OTHER', '   ', %L)$$, (SELECT id FROM t_eo)), '22023', 'EXR-03 blank description refused');
SELECT food_test.raises(format($$SELECT public.food_raise_exception('OTHER', repeat('x',501), %L)$$, (SELECT id FROM t_eo)), '22023', 'EXR-04 description over 500 chars refused');
CREATE TEMP TABLE t_ex ON COMMIT DROP AS
  SELECT public.food_raise_exception('MISSING_ITEM', 'Beans missing', (SELECT id FROM t_eo)) AS r;
SELECT food_test.ok((SELECT r->>'raised_via' FROM t_ex) = 'employee', 'EXR-05 employee reports a problem on their own order');
SELECT food_test.raises(format($$SELECT public.food_raise_exception('OTHER', 'again', %L)$$, (SELECT id FROM t_eo)), '22023', 'EXR-06 one open report per order per employee');
SELECT food_test.ok((SELECT count(*) FROM public.food_exceptions) = 1, 'EXR-07 employee reads their own report');
SELECT food_test.ok((SELECT count(*) FROM public.food_order_events WHERE order_id=(SELECT id FROM t_eo) AND event_type='problem_reported') = 1, 'EXR-08 report appears on the order timeline');
SELECT food_test.ok((SELECT payment_status='pending_payment' AND fulfilment_status='confirmed' FROM public.food_orders WHERE id=(SELECT id FROM t_eo)), 'EXR-09 raising changes neither payment nor fulfilment status');
SELECT food_test.raises(format($$SELECT public.food_resolve_exception(%L, 'self-close')$$, (SELECT (r->>'exception_id')::uuid FROM t_ex)), '42501', 'EXR-10 employee cannot resolve their own report');
SELECT food_test.raises($$DELETE FROM public.food_exceptions$$, '42501', 'EXR-11 employee cannot delete exceptions');
SELECT food_test.act_as(food_test.id('emp_b'));
SELECT food_test.raises(format($$SELECT public.food_raise_exception('OTHER', 'not mine', %L)$$, (SELECT id FROM t_eo)), '42501', 'EXR-12 cannot report on another employee order');
SELECT food_test.ok((SELECT count(*) FROM public.food_exceptions) = 0, 'EXR-13 employee B cannot read employee A report');
SELECT food_test.act_as(food_test.id('tenant'));
SELECT food_test.raises(format($$SELECT public.food_raise_exception('OTHER', 'tenant', %L)$$, (SELECT id FROM t_eo)), '42501', 'EXR-14 non-staff cannot raise');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_raise_exception('STOCK_UNAVAILABLE', 'Greens ran short at 13:10')->>'raised_via') = 'coordinator', 'EXR-15 coordinator logs an exception without an order');
SELECT food_test.ok((SELECT count(*) FROM public.food_exceptions) = 2, 'EXR-16 coordinator sees all exceptions');
SELECT public.food_resolve_exception((SELECT (r->>'exception_id')::uuid FROM t_ex), 'Beans brought to the desk');
SELECT food_test.ok((public.food_coordinator_overview()->>'open_exceptions')::int = 1, 'EXR-17 overview counts open exceptions');
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.ok((SELECT resolution_reason FROM public.food_exceptions) = 'Beans brought to the desk', 'EXR-18 employee sees how their report was resolved');
SELECT food_test.ok((public.food_raise_exception('OTHER', 'second issue after resolution', (SELECT id FROM t_eo))->>'raised_via') = 'employee', 'EXR-19 a new report is allowed once the earlier one is resolved');
RESET ROLE;
SELECT food_test.raises($$DELETE FROM public.food_exceptions$$, 'P0001', 'EXR-20 exceptions are never deleted, even by the owner');
SELECT food_test.ok((SELECT count(*) FROM public.food_audit WHERE entity='exception' AND action='raised') = 3, 'EXR-21 every raise is audited');
ROLLBACK;

-- ─────────── FM-26f: canteen self-check ───────────
BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.ok(public.food_can_use_canteen(), 'CAN-USE-01 employee may use the canteen');
SELECT food_test.act_as(food_test.id('tenant'));
SELECT food_test.ok(NOT public.food_can_use_canteen(), 'CAN-USE-02 tenant may not');
SET LOCAL ROLE anon;
SELECT food_test.raises($$SELECT public.food_can_use_canteen()$$, '42501', 'CAN-USE-03 anon cannot call it');
ROLLBACK;

-- ─────────── FM-17: bootstrap is service-side only ───────────
BEGIN;
SELECT food_test.act_as(food_test.id('emp_ok'));
SELECT food_test.raises(format($$SELECT public.food_bootstrap_coordinator(%L, 'self appointment attempt')$$, food_test.id('emp_ok')), '42501', 'BOOT-01 a signed-in user cannot bootstrap');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT food_test.raises(format($$SELECT public.food_bootstrap_coordinator(%L, 'first coordinator appointment')$$, food_test.id('emp_ok')), '22023', 'BOOT-02 refused while a coordinator is seated');
RESET ROLE;
UPDATE public.food_coordinator_assignments SET revoked_at = now() WHERE revoked_at IS NULL;
SET LOCAL ROLE service_role;
SELECT food_test.raises(format($$SELECT public.food_bootstrap_coordinator(%L, 'appoint a tenant please')$$, food_test.id('tenant')), 'P0002', 'BOOT-03 ineligible appointee refused');
SELECT food_test.raises(format($$SELECT public.food_bootstrap_coordinator(%L, 'short')$$, food_test.id('emp_ok')), '22023', 'BOOT-04 short reason refused');
SELECT food_test.ok((public.food_bootstrap_coordinator(food_test.id('emp_ok'), 'first coordinator appointment')->>'status') = 'appointed', 'BOOT-05 service role appoints an eligible employee');
SELECT food_test.raises(format($$SELECT public.food_bootstrap_coordinator(%L, 'second appointment attempt')$$, food_test.id('emp_a')), '22023', 'BOOT-06 only one bootstrap');
RESET ROLE;
SELECT food_test.ok((SELECT count(*) FROM public.food_audit WHERE action='bootstrap_appointed') = 1, 'BOOT-07 bootstrap is audited');
ROLLBACK;

-- ─────────── FM-23: no session temp table ───────────
BEGIN;
SELECT food_test.ok((SELECT prosrc !~* 'create\s+temp(orary)?\s+table' FROM pg_proc WHERE oid = 'public.food_place_order(jsonb,text,text,text)'::regprocedure), 'FM23-01 food_place_order uses no temp table');
-- a caller-owned temp table of the old name has no effect any more
CREATE TEMP TABLE _food_basket (menu_item_id uuid, quantity int);
GRANT ALL ON _food_basket TO authenticated;
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.ok((public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi'), 'quantity', 2)),'k-shadow','cash')->>'total_ugx')::numeric = 10000, 'FM23-02 a pre-created _food_basket cannot alter an order');
ROLLBACK;

-- ─────────── payment modes: each one moves no money ───────────
BEGIN;
SELECT food_test.act_as(food_test.id('emp_b'));
SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi2'), 'quantity', 1)), 'k-pm-' || m, m)
  FROM unnest(ARRAY['cash','wallet','mobile_money']) m;
RESET ROLE;
SELECT food_test.ok((SELECT count(*) FROM public.food_orders WHERE employee_id=food_test.id('emp_b') AND payment_mode IN ('cash','wallet','mobile_money')
                       AND payment_status='pending_payment' AND paid_at IS NULL AND transaction_group_id IS NULL) = 3,
                    'PM-01 all three modes recorded; none paid, none with a transaction');
-- the only tables any food function writes are food_* tables
SELECT food_test.ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND (p.proname LIKE 'food\_%' OR p.proname LIKE '%food\_coordinator%')
     AND p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(?!food_)[a-z_]+\b'
     AND p.prosrc !~* '^\s*$'), 'PM-02 food functions write only food_* tables');
ROLLBACK;

-- ─────────── nine approved exception kinds (exact set) ───────────
BEGIN;
SELECT food_test.act_as(food_test.id('coord'));
-- raise one of each (its own statement, so the check below sees the rows)
SELECT count(public.food_raise_exception(k, 'kind check ' || k)) AS raised
  FROM unnest(ARRAY['MISSING_ITEM','WRONG_ITEM','QUALITY_ISSUE','LATE_DELIVERY','NOT_DELIVERED',
                    'DAMAGED_ORDER','STOCK_UNAVAILABLE','ORDER_ERROR','OTHER']) k;
SELECT food_test.ok((SELECT array_agg(DISTINCT kind ORDER BY kind) FROM public.food_exceptions)
                    = ARRAY['DAMAGED_ORDER','LATE_DELIVERY','MISSING_ITEM','NOT_DELIVERED','ORDER_ERROR',
                            'OTHER','QUALITY_ISSUE','STOCK_UNAVAILABLE','WRONG_ITEM'],
                    'KIND-01 each of the nine approved kinds is accepted and stored as given');
SELECT food_test.raises($$SELECT public.food_raise_exception('stock_shortfall', 'old code')$$, '22023', 'KIND-02 a superseded lowercase code is refused');
SELECT food_test.raises($$SELECT public.food_raise_exception('missing_item', 'wrong case')$$, '22023', 'KIND-03 codes are case-exact');
SELECT food_test.raises($$SELECT public.food_raise_exception('REFUND', 'not a kind')$$, '22023', 'KIND-04 an unapproved kind is refused');
SELECT food_test.raises($$SELECT public.food_raise_exception(NULL, 'no kind')$$, '22023', 'KIND-05 a missing kind is refused');
RESET ROLE;
SELECT food_test.raises($$INSERT INTO public.food_exceptions (kind, detail) VALUES ('stock_shortfall', '{}')$$, '23514', 'KIND-06 the table constraint refuses an unapproved kind even for the owner');
SELECT food_test.ok((SELECT pg_get_constraintdef(oid) ~ 'MISSING_ITEM.*WRONG_ITEM.*QUALITY_ISSUE.*LATE_DELIVERY.*NOT_DELIVERED.*DAMAGED_ORDER.*STOCK_UNAVAILABLE.*ORDER_ERROR.*OTHER'
                       FROM pg_constraint WHERE conname = 'food_exceptions_kind_known'),
                    'KIND-07 the constraint lists exactly the approved codes');
SELECT food_test.ok((SELECT count(*) FROM public.food_orders WHERE payment_status <> 'pending_payment') = 0
                AND (SELECT count(*) FROM public.food_exceptions WHERE kind IN ('NOT_DELIVERED','LATE_DELIVERY')) = 2,
                    'KIND-08 delivery-related kinds are records only: no payment status changes');
ROLLBACK;
