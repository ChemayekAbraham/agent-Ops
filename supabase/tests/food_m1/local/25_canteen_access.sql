-- FM-15: the canteen is for staff (enabled 'employee' role) and Food
-- Coordinators only. Runs in the same session as 10_behaviour.sql.

BEGIN;
SELECT food_test.act_as(food_test.id('tenant'));
SELECT food_test.raises($$SELECT public.food_menu_for_day()$$, '42501', 'ACC-01 a tenant cannot read the canteen menu');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',1)),'k-tenant','cash')$$, pg_temp.v('mi')), '42501', 'ACC-02 a tenant cannot place a canteen order');
SELECT food_test.act_as(food_test.id('emp_off'));
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',1)),'k-off','cash')$$, pg_temp.v('mi')), '42501', 'ACC-03 a disabled employee cannot order');
SELECT food_test.act_as(food_test.id('emp_gone'));
SELECT food_test.raises($$SELECT public.food_menu_for_day()$$, '42501', 'ACC-04 a deleted profile cannot read the menu');
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.ok(jsonb_typeof(public.food_menu_for_day()->'periods') = 'array', 'ACC-05 an enabled employee reads the menu');
SELECT food_test.ok((public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi'), 'quantity', 1)),'k-staff','cash')->>'replayed') = 'false', 'ACC-06 an enabled employee orders');
SELECT food_test.raises($$SELECT public.food_require_canteen_user()$$, '42501', 'ACC-07 the guard is not callable directly');
SELECT food_test.raises(format($$SELECT public.food_is_canteen_user(%L)$$, food_test.id('emp_b')), '42501', 'ACC-08 eligibility of others cannot be probed');
ROLLBACK;

-- a coordinator with no employee role still reaches the menu screen
BEGIN;
DELETE FROM public.user_roles WHERE user_id = food_test.id('coord');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok(jsonb_typeof(public.food_menu_for_day()->'periods') = 'array', 'ACC-09 coordinator without an employee role reads the menu');
ROLLBACK;
