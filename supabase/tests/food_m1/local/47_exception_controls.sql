-- Exception controls (20261013127000). Runs after 10_behaviour.sql in the same
-- session: reuses its helpers, menu (pg_temp.v('mi2')) and coordinator.

BEGIN;
-- the coordinator orders for themselves and logs a problem with that order
SELECT food_test.act_as(food_test.id('coord'));
CREATE TEMP TABLE t_self AS
  SELECT (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi2'), 'quantity', 1)),
                                  'self-order-1', 'cash')->>'order_id')::uuid AS order_id;
GRANT ALL ON t_self TO authenticated;
CREATE TEMP TABLE t_selfx AS
  SELECT (public.food_raise_exception('WRONG_ITEM', 'My own order was wrong', (SELECT order_id FROM t_self))->>'exception_id')::uuid AS id;
GRANT ALL ON t_selfx TO authenticated;
SELECT food_test.raises(format($$SELECT public.food_resolve_exception(%L, 'closing my own complaint')$$, (SELECT id FROM t_selfx)),
                        '42501', 'SELF-01 a coordinator cannot resolve an exception about their own order');
SELECT food_test.ok((SELECT resolved_at IS NULL FROM public.food_exceptions WHERE id = (SELECT id FROM t_selfx)),
                    'SELF-02 ...and it stays open');

-- an employee's exception: the coordinator still resolves it (regression)
SELECT food_test.act_as(food_test.id('emp_b'));
CREATE TEMP TABLE t_emp AS
  SELECT (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi2'), 'quantity', 1)),
                                  'emp-b-order-x', 'cash')->>'order_id')::uuid AS order_id;
GRANT ALL ON t_emp TO authenticated;
CREATE TEMP TABLE t_empx AS
  SELECT (public.food_raise_exception('MISSING_ITEM', 'Beans missing', (SELECT order_id FROM t_emp))->>'exception_id')::uuid AS id;
GRANT ALL ON t_empx TO authenticated;
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((public.food_resolve_exception((SELECT id FROM t_empx), 'Beans delivered to the desk')->>'resolved_by')::uuid = food_test.id('coord'),
                    'SELF-03 the coordinator still resolves an employee''s exception');

-- after a handover, the new coordinator resolves the old coordinator's own-order exception
SELECT public.food_transfer_coordinator(food_test.id('emp_ok'), 'full_transfer', 'handover so the complaint can be closed');
SELECT food_test.act_as(food_test.id('emp_ok'));
SELECT food_test.ok((public.food_resolve_exception((SELECT id FROM t_selfx), 'Replaced the meal for the previous coordinator')->>'resolved_by')::uuid = food_test.id('emp_ok'),
                    'SELF-04 a different active coordinator can resolve it');
RESET ROLE;
SELECT food_test.ok((SELECT count(*) FROM public.food_audit
                      WHERE entity = 'exception' AND entity_id = (SELECT id FROM t_selfx) AND action = 'resolved'
                        AND actor_id = food_test.id('emp_ok')) = 1,
                    'SELF-05 the resolution is audited with the resolving actor');
SELECT food_test.ok((SELECT payment_status = 'pending_payment' AND fulfilment_status = 'confirmed'
                       FROM public.food_orders WHERE id = (SELECT order_id FROM t_self)),
                    'SELF-06 raising and resolving never change the order or payment status');
SELECT food_test.ok((SELECT proconfig::text LIKE '%pg_temp%' FROM pg_proc WHERE proname = 'food_resolve_exception'),
                    'SELF-07 the resolver keeps search_path with pg_temp last');
ROLLBACK;
