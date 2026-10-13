-- Regression tests for 20261012120000_food_m1_release_corrections.sql.
-- Runs in the SAME session as 10_behaviour.sql (run.sh concatenates them), so
-- it reuses that file's identities, menu and helpers. Each test names the
-- register finding or decision it closes.

BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',1)),'k-nomode', NULL)$$, pg_temp.v('mi')), '22023', 'REL-D1a payment mode is required');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',1)),'k-badmode','card')$$, pg_temp.v('mi')), '22023', 'REL-D1b unknown payment mode refused');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',1)),'k-3arg', 'no onions')$$, pg_temp.v('mi')), '22023', 'REL-D1c an old 3-argument call cannot slip instructions in as a mode');
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='food_place_order' AND pronargs=3), 'REL-D1d no 3-argument overload remains');
CREATE TEMP TABLE t_w ON COMMIT DROP AS
  SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi'), 'quantity', 1)), 'k-wallet', 'wallet') AS r;
SELECT food_test.ok((SELECT payment_mode='wallet' AND payment_status='pending_payment' AND paid_at IS NULL AND transaction_group_id IS NULL
                       FROM public.food_orders WHERE id=(SELECT (r->>'order_id')::uuid FROM t_w)), 'REL-D1e wallet mode is recorded only: unpaid, no transaction');
SELECT food_test.ok((SELECT r->>'payment_mode' FROM t_w) = 'wallet', 'REL-D1f mode returned to the caller');
SELECT food_test.ok((SELECT (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi'), 'quantity', 1)), 'k-wallet', 'cash'))->>'payment_mode') = 'wallet', 'REL-D1g replay returns the original mode, never rewrites it');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',21)),'k-21','cash')$$, pg_temp.v('mi3')), '22023', 'REL-D3a more than 20 of one meal refused');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',15), jsonb_build_object('menu_item_id', %L,'quantity',6)),'k-21b','cash')$$, pg_temp.v('mi3'), pg_temp.v('mi3')), '22023', 'REL-D3b limit applies after duplicate lines merge');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',1)),'k-long','cash', repeat('x',501))$$, pg_temp.v('mi3')), '22023', 'REL-D3c instructions over 500 chars refused');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity','1.5')),'k-frac','cash')$$, pg_temp.v('mi3')), '22023', 'REL-D3d non-integer quantity refused cleanly');
SELECT food_test.raises($$SELECT public.food_place_order('["x"]'::jsonb,'k-shape','cash')$$, '22023', 'REL-D3e malformed line refused cleanly');
ROLLBACK;

-- D2 / FM-06: an unpaid order goes all the way to handover; payment untouched
BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
CREATE TEMP TABLE t_u ON COMMIT DROP AS
  SELECT (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi3'), 'quantity', 1)),'k-unpaid','mobile_money')->>'order_id')::uuid AS id;
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((SELECT total_quantity FROM public.food_preparation_list() WHERE meal_name='Matooke') = 1, 'REL-FM07a kitchen list includes the unpaid order');
SELECT food_test.ok((public.food_coordinator_overview()->>'fulfilment_requires_payment')::boolean = false
                AND (public.food_coordinator_overview()->>'awaiting_prep')::int = 1
                AND (public.food_coordinator_overview()->'by_payment_mode'->>'mobile_money')::int = 1, 'REL-FM07b overview reports unpaid orders awaiting prep and the mode mix');
SELECT public.food_set_fulfilment((SELECT id FROM t_u), 'preparing');
SELECT public.food_set_fulfilment((SELECT id FROM t_u), 'ready');
SELECT public.food_set_fulfilment((SELECT id FROM t_u), 'delivered');
SELECT food_test.ok((SELECT fulfilment_status='delivered' AND payment_status='pending_payment' AND paid_at IS NULL AND transaction_group_id IS NULL
                       FROM public.food_orders WHERE id=(SELECT id FROM t_u)), 'REL-D2a unpaid order delivered; still unpaid, no transaction');
SELECT food_test.ok((public.food_coordinator_overview()->>'unpaid_handed_over')::int = 1, 'REL-D2b overview counts delivered-but-unpaid');
SELECT food_test.act_as((SELECT employee_id FROM public.food_orders WHERE id = (SELECT id FROM t_u)));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT id FROM t_u)), '22023', 'REL-D2c delivery alone does not make payment available (receipt confirmation required)');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises(format($$SELECT public.food_set_fulfilment(%L,'cancelled')$$, (SELECT id FROM t_u)), '22023', 'REL-D2d delivered order cannot be cancelled');
ROLLBACK;

-- FM-09: closing a day with a live order is refused, paid or not
BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi3'), 'quantity', 1)),'k-close','cash');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises($$SELECT public.food_set_closure((now() AT TIME ZONE 'Africa/Kampala')::date, true, 'power cut')$$, '22023', 'REL-FM09 cannot close a day with a live unpaid order');
ROLLBACK;

-- FM-10: archived meal leaves the employee menu
BEGIN;
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_set_meal_status(pg_temp.v('meal2'), 'archived', 'test');
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.food_menu_for_day()->'periods') p,
                                     jsonb_array_elements(p->'meals') m WHERE m->>'name'='Rolex'), 'REL-FM10 archived meal not listed');
ROLLBACK;

-- FM-12: no probing of another person's coordinator status
BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.ok(public.is_food_coordinator(food_test.id('coord')) = false AND public.is_active_food_coordinator(food_test.id('coord')) = false, 'REL-FM12a employee cannot probe the coordinator');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok(public.is_active_food_coordinator(auth.uid()), 'REL-FM12b coordinator still recognised for self');
ROLLBACK;

-- FM-14: names only for food participants, coordinator only
BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi3'), 'quantity', 1)),'k-names','cash');
SELECT food_test.raises(format($$SELECT * FROM public.food_people_names(ARRAY[%L]::uuid[])$$, food_test.id('emp_b')), '42501', 'REL-FM14a employee cannot look up names');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((SELECT count(*) FROM public.food_people_names(ARRAY[food_test.id('emp_a'), food_test.id('emp_b'), food_test.id('tenant')])) = 1
                AND (SELECT full_name FROM public.food_people_names(ARRAY[food_test.id('emp_a')])) = 'TEST EMP_A', 'REL-FM14b coordinator gets names of ordering employees only');
ROLLBACK;

-- FM-13 and grants on the new objects
BEGIN;
SELECT food_test.ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prosecdef
     AND (p.proname LIKE 'food\_%' OR p.proname LIKE 'is\_%food\_coordinator')
     AND NOT ('search_path=public, pg_temp' = ANY (coalesce(p.proconfig,'{}')))), 'REL-FM13 every food definer function pins pg_temp last');
SELECT food_test.ok(NOT has_function_privilege('anon', 'public.food_place_order(jsonb,text,text,text)', 'execute')
                AND NOT has_function_privilege('anon', 'public.food_people_names(uuid[])', 'execute')
                AND has_function_privilege('authenticated', 'public.food_place_order(jsonb,text,text,text)', 'execute'), 'REL-GR1 new functions: anon none, authenticated execute');
SELECT food_test.ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prosecdef AND (p.proname LIKE 'food\_%' OR p.proname LIKE 'is\_%food\_coordinator')
     AND has_function_privilege('anon', p.oid, 'execute')), 'REL-GR2 anon can execute no food definer function');
ROLLBACK;
