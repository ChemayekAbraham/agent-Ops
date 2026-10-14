-- Staff eligibility includes Platform Sales Officers (20261013125000).
-- Runs in the same session as 10_behaviour.sql (reuses its helpers, menu and
-- coordinator). Synthetic identities only.
--   pso         : agent role only, current "Platform Sales Officer" assignment
--   pso_ended   : agent role only, the PSO assignment has ended
--   pso_other   : agent role only, current assignment to another position
--   pso_deleted : agent role only, current PSO assignment, profile soft-deleted

INSERT INTO food_test.ids VALUES
  ('pso',         'f0000000-0000-4000-8000-0000000000f1'),
  ('pso_ended',   'f0000000-0000-4000-8000-0000000000f2'),
  ('pso_other',   'f0000000-0000-4000-8000-0000000000f3'),
  ('pso_deleted', 'f0000000-0000-4000-8000-0000000000f4');
INSERT INTO auth.users (id, email)
SELECT id, k || '@example.invalid' FROM food_test.ids WHERE k LIKE 'pso%';
INSERT INTO public.profiles (id, full_name, email, deleted_at)
SELECT id, 'TEST ' || upper(k), k || '@example.invalid',
       CASE WHEN k = 'pso_deleted' THEN now() END
  FROM food_test.ids WHERE k LIKE 'pso%';
INSERT INTO public.user_roles (user_id, role, enabled)
SELECT id, 'agent'::public.app_role, true FROM food_test.ids WHERE k LIKE 'pso%';
INSERT INTO public.hr_positions (id, title) VALUES
  ('f0000000-0000-4000-8000-00000000aa01', 'Platform Sales Officer'),
  ('f0000000-0000-4000-8000-00000000aa02', 'Driver');
INSERT INTO public.hr_staff (id, user_id, staff_ref)
SELECT ('f0000000-0000-4000-8000-0000000bb0' || right(id::text, 2))::uuid, id, 'S-' || k
  FROM food_test.ids WHERE k LIKE 'pso%';
INSERT INTO public.hr_assignments (staff_id, position_id, started_on, ended_on)
SELECT s.id,
       CASE WHEN i.k = 'pso_other' THEN 'f0000000-0000-4000-8000-00000000aa02'::uuid
            ELSE 'f0000000-0000-4000-8000-00000000aa01'::uuid END,
       current_date - 30,
       CASE WHEN i.k = 'pso_ended' THEN current_date - 1 END
  FROM public.hr_staff s JOIN food_test.ids i ON i.id = s.user_id;

SELECT food_test.ok(public.food_is_staff(food_test.id('pso')), 'PSO-01 a current PSO officer without an employee role is staff');
SELECT food_test.ok(NOT public.food_is_staff(food_test.id('pso_ended')), 'PSO-02 an ended PSO assignment is not staff');
SELECT food_test.ok(NOT public.food_is_staff(food_test.id('pso_other')), 'PSO-03 another HR position is not staff');
SELECT food_test.ok(NOT public.food_is_staff(food_test.id('pso_deleted')), 'PSO-04 a soft-deleted PSO officer is not staff');
SELECT food_test.ok(public.food_is_staff(food_test.id('emp_a')) AND NOT public.food_is_staff(food_test.id('emp_off'))
                AND NOT public.food_is_staff(food_test.id('tenant')) AND NOT public.food_is_staff(food_test.id('emp_gone')),
                    'PSO-05 employee rule unchanged: enabled employee yes; disabled, tenant, deleted no');

-- canteen access and ordering
BEGIN;
SELECT food_test.act_as(food_test.id('pso'));
SELECT food_test.ok(public.food_can_use_canteen(), 'PSO-06 a PSO officer can use the canteen');
SELECT food_test.ok((public.food_menu_for_day()->'periods') IS NOT NULL, 'PSO-07 a PSO officer can read the menu');
SELECT food_test.ok((public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi2'), 'quantity', 1)),
                     'pso-order-1', 'cash')->>'order_id') IS NOT NULL, 'PSO-08 a PSO officer can place an order');
SELECT food_test.raises($$SELECT public.food_is_staff(auth.uid())$$, '42501', 'PSO-09 the staff predicate is not callable by signed-in users');
SELECT food_test.act_as(food_test.id('pso_ended'));
SELECT food_test.ok(NOT public.food_can_use_canteen(), 'PSO-10 an ended PSO officer cannot use the canteen');
SELECT food_test.raises($$SELECT public.food_menu_for_day()$$, '42501', 'PSO-11 an ended PSO officer cannot read the menu');
ROLLBACK;

-- successor lookup and handover
BEGIN;
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok(EXISTS (SELECT 1 FROM public.food_coordinator_candidates() c WHERE c.user_id = food_test.id('pso')),
                    'PSO-12 the successor lookup offers a PSO officer');
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM public.food_coordinator_candidates() c
                                 WHERE c.user_id IN (food_test.id('pso_ended'), food_test.id('pso_other'), food_test.id('pso_deleted'),
                                                     food_test.id('tenant'), food_test.id('emp_off'), food_test.id('emp_gone'), food_test.id('coord'))),
                    'PSO-13 the lookup still excludes ineligible accounts and self');
SELECT food_test.ok((SELECT count(*) FROM public.food_coordinator_candidates() c WHERE c.user_id = food_test.id('emp_a')) = 1,
                    'PSO-14 employees are listed once (no duplicates from the union)');
SELECT food_test.raises(format($$SELECT public.food_transfer_coordinator(%L,'full_transfer','handover to ended PSO')$$, food_test.id('pso_ended')),
                        'P0002', 'PSO-15 handover to an ended PSO officer is refused');
SELECT food_test.ok((public.food_transfer_coordinator(food_test.id('pso'), 'full_transfer', 'handover to the PSO officer')->>'status') = 'transferred',
                    'PSO-16 handover to a current PSO officer succeeds');
ROLLBACK;

-- first appointment (service role), with nobody seated
BEGIN;
RESET ROLE;
UPDATE public.food_coordinator_assignments SET revoked_at = now() WHERE revoked_at IS NULL;
SET LOCAL ROLE service_role;
SELECT food_test.raises(format($$SELECT public.food_bootstrap_coordinator(%L, 'appoint an ended PSO officer')$$, food_test.id('pso_ended')),
                        'P0002', 'PSO-17 bootstrap refuses an ended PSO officer');
SELECT food_test.ok((public.food_bootstrap_coordinator(food_test.id('pso'), 'appoint the PSO officer first')->>'status') = 'appointed',
                    'PSO-18 bootstrap can appoint a current PSO officer');
ROLLBACK;
