-- Food M1 behavioural suite. Runs in a DISPOSABLE database built from
-- 00_supabase_scaffold.sql plus the shipping Food migrations.
--
-- Every user action runs as the real `authenticated` role (SET LOCAL ROLE) with
-- request.jwt.claims set, as PostgREST does, so grants and RLS are exercised for
-- real. Results are NOTICE lines 'PASS <id>' / 'FAIL <id> ...'; the runner
-- counts them and fails on any FAIL or on a missing expected id.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;

DROP SCHEMA IF EXISTS food_test CASCADE;
CREATE SCHEMA food_test;
GRANT USAGE ON SCHEMA food_test TO anon, authenticated, service_role;

CREATE FUNCTION food_test.ok(p_cond boolean, p_id text, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p_cond, false) THEN RAISE NOTICE 'PASS %', p_id;
  ELSE RAISE NOTICE 'FAIL % %', p_id, p_detail; END IF;
END $$;

-- Runs p_sql as the CURRENT role and asserts it raises p_state.
CREATE FUNCTION food_test.raises(p_sql text, p_state text, p_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE NOTICE 'FAIL % expected SQLSTATE % but the statement succeeded', p_id, p_state;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = p_state THEN RAISE NOTICE 'PASS %', p_id;
  ELSE RAISE NOTICE 'FAIL % expected % got % (%)', p_id, p_state, SQLSTATE, SQLERRM; END IF;
END $$;

-- Acts as a user for the rest of the transaction.
CREATE FUNCTION food_test.act_as(p_uid uuid, p_role text DEFAULT 'authenticated')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', p_role)::text, true);
  PERFORM set_config('role', p_role, true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA food_test TO anon, authenticated, service_role;

-- ───────────────────────────── identities ─────────────────────────────
-- COORD is the migration's seeded coordinator (a synthetic stand-in here).
CREATE TABLE food_test.ids (k text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO food_test.ids VALUES
  ('coord',  '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'),
  ('emp_a',  'f0000000-0000-4000-8000-0000000000a1'),
  ('emp_b',  'f0000000-0000-4000-8000-0000000000b1'),
  ('emp_ok', 'f0000000-0000-4000-8000-0000000000e1'),
  ('emp_off','f0000000-0000-4000-8000-0000000000e2'),
  ('emp_gone','f0000000-0000-4000-8000-0000000000e3'),
  ('tenant', 'f0000000-0000-4000-8000-0000000000d1');
GRANT SELECT ON food_test.ids TO anon, authenticated, service_role;
CREATE FUNCTION food_test.id(p_k text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT id FROM food_test.ids WHERE k = p_k $$;
GRANT EXECUTE ON FUNCTION food_test.id(text) TO anon, authenticated, service_role;

INSERT INTO auth.users (id, email)
SELECT id, k || '@example.invalid' FROM food_test.ids WHERE k <> 'coord';
INSERT INTO public.profiles (id, full_name, email, deleted_at)
SELECT id, 'TEST ' || upper(k), k || '@example.invalid',
       CASE WHEN k = 'emp_gone' THEN now() END
  FROM food_test.ids WHERE k <> 'coord';
INSERT INTO public.user_roles (user_id, role, enabled)
SELECT id, CASE WHEN k = 'tenant' THEN 'tenant' ELSE 'employee' END::public.app_role,
       k <> 'emp_off'
  FROM food_test.ids WHERE k <> 'coord';

-- ─────────────────── coordinator builds a menu (committed) ───────────────────
BEGIN;
SELECT food_test.act_as(food_test.id('coord'));
CREATE TEMP TABLE IF NOT EXISTS t_ctx (k text PRIMARY KEY, v uuid);
GRANT ALL ON t_ctx TO authenticated;
COMMIT;

BEGIN;
SELECT food_test.act_as(food_test.id('coord'));
INSERT INTO t_ctx VALUES ('cat', public.food_upsert_category(NULL, 'Mains', 10, 'test'));
INSERT INTO t_ctx VALUES ('meal', public.food_upsert_meal(NULL, 'Matooke', 'with beans',
  (SELECT v FROM t_ctx WHERE k='cat'), 5000, NULL, 'test'));
INSERT INTO t_ctx VALUES ('meal2', public.food_upsert_meal(NULL, 'Rolex', NULL,
  (SELECT v FROM t_ctx WHERE k='cat'), 3000, NULL, 'test'));
SELECT public.food_set_meal_status((SELECT v FROM t_ctx WHERE k='meal'), 'published', 'test');
SELECT public.food_set_meal_status((SELECT v FROM t_ctx WHERE k='meal2'), 'published', 'test');
-- one all-day period with a per-employee cap of 3, one without a cap
INSERT INTO t_ctx VALUES ('per', public.food_upsert_service_period(NULL, 'Lunch',
  '00:00', '23:59:59', 'Canteen', 3, true, 'test'));
INSERT INTO t_ctx VALUES ('per2', public.food_upsert_service_period(NULL, 'Supper',
  '00:00', '23:59:59', NULL, NULL, true, 'test'));
INSERT INTO t_ctx VALUES ('mi', public.food_schedule_meal((now() AT TIME ZONE 'Africa/Kampala')::date,
  (SELECT v FROM t_ctx WHERE k='per'), (SELECT v FROM t_ctx WHERE k='meal'), NULL, 5, true));
INSERT INTO t_ctx VALUES ('mi2', public.food_schedule_meal((now() AT TIME ZONE 'Africa/Kampala')::date,
  (SELECT v FROM t_ctx WHERE k='per'), (SELECT v FROM t_ctx WHERE k='meal2'), 2500, NULL, true));
INSERT INTO t_ctx VALUES ('mi3', public.food_schedule_meal((now() AT TIME ZONE 'Africa/Kampala')::date,
  (SELECT v FROM t_ctx WHERE k='per2'), (SELECT v FROM t_ctx WHERE k='meal'), NULL, 2, true));
COMMIT;

CREATE FUNCTION pg_temp.v(p_k text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM t_ctx WHERE k=p_k $$;

-- ═════════════════════════ SEC: grants and RLS ═════════════════════════
BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.raises($$INSERT INTO public.food_orders (order_reference, employee_id, service_date, period_id, total_ugx, idempotency_key)
  VALUES ('X', auth.uid(), current_date, '00000000-0000-0000-0000-000000000000', 0, 'x')$$, '42501', 'SEC-01 employee cannot INSERT food_orders');
SELECT food_test.raises($$UPDATE public.food_orders SET payment_status='paid'$$, '42501', 'SEC-02 employee cannot UPDATE food_orders.payment_status');
SELECT food_test.raises($$UPDATE public.food_menu_items SET servings_reserved=0$$, '42501', 'SEC-03 employee cannot UPDATE stock');
SELECT food_test.raises($$DELETE FROM public.food_audit$$, '42501', 'SEC-04 employee cannot DELETE audit');
SELECT food_test.raises($$INSERT INTO public.food_coordinator_assignments (coordinator_id) VALUES (auth.uid())$$, '42501', 'SEC-05 employee cannot self-appoint');
SELECT food_test.raises($$SELECT public.food_audit_write('order', NULL, 'forged', NULL, NULL, NULL, auth.uid())$$, '42501', 'SEC-06 employee cannot call food_audit_write');
SELECT food_test.raises($$SELECT public.food_require_active_coordinator()$$, '42501', 'SEC-07 employee cannot call food_require_active_coordinator');
SELECT food_test.ok((SELECT count(*) FROM public.food_audit) = 0, 'SEC-08 employee reads no audit rows');
SELECT food_test.ok((SELECT count(*) FROM public.food_coordinator_assignments) = 0, 'SEC-09 employee reads no coordinator assignments');
SELECT food_test.raises($$SELECT public.food_upsert_meal(NULL,'Hack',NULL,NULL,1)$$, '42501', 'SEC-10 employee cannot author meals');
SELECT food_test.raises($$SELECT public.food_set_fulfilment(gen_random_uuid(),'preparing')$$, '42501', 'SEC-11 employee cannot change fulfilment');
SELECT food_test.raises($$SELECT public.food_transfer_coordinator(auth.uid(),'full_transfer','takeover attempt')$$, '42501', 'SEC-12 employee cannot take the coordinator role');
SELECT food_test.raises($$SELECT * FROM public.food_coordinator_candidates()$$, '42501', 'SEC-13 employee cannot enumerate candidates');
SELECT food_test.raises($$SELECT public.food_coordinator_overview()$$, '42501', 'SEC-14 employee cannot read the overview');
ROLLBACK;

BEGIN;
SET LOCAL ROLE anon;
SELECT food_test.raises($$SELECT count(*) FROM public.food_orders$$, '42501', 'SEC-20 anon cannot read food_orders');
SELECT food_test.raises($$SELECT public.food_menu_for_day()$$, '42501', 'SEC-21 anon cannot call food_menu_for_day');
SELECT food_test.raises($$SELECT public.food_place_order('[]','k','cash')$$, '42501', 'SEC-22 anon cannot call food_place_order');
ROLLBACK;

-- ═════════════════════════ ORD: ordering ═════════════════════════
BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.raises($$SELECT public.food_place_order('[]'::jsonb,'k-empty','cash')$$, '22023', 'ORD-01 empty basket refused');
SELECT food_test.raises($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', gen_random_uuid(),'quantity',1)),'k-unknown','cash')$$, 'P0002', 'ORD-02 unknown menu item refused');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',0)),'k-zero','cash')$$, pg_temp.v('mi')), '22023', 'ORD-03 zero quantity refused');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',1), jsonb_build_object('menu_item_id', %L,'quantity',1)),'k-mix','cash')$$, pg_temp.v('mi'), pg_temp.v('mi3')), '22023', 'ORD-04 mixed service periods refused');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',4)),'k-cap','cash')$$, pg_temp.v('mi2')), '22023', 'ORD-05 per-employee cap enforced');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',3)),'k-stock','cash')$$, pg_temp.v('mi3')), '22023', 'ORD-06 oversell refused');
ROLLBACK;

BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
CREATE TEMP TABLE t_res ON COMMIT DROP AS
  SELECT public.food_place_order(jsonb_build_array(
           jsonb_build_object('menu_item_id', pg_temp.v('mi'), 'quantity', 1),
           jsonb_build_object('menu_item_id', pg_temp.v('mi2'), 'quantity', 2)),
         'k-a-1','cash', 'no onions') AS r;
SELECT food_test.ok((SELECT (r->>'total_ugx')::numeric FROM t_res) = 10000, 'ORD-10 total is server-computed from day prices (5000 + 2*2500)');
SELECT food_test.ok((SELECT r->>'payment_status' FROM t_res) = 'pending_payment', 'ORD-11 order is created unpaid');
SELECT food_test.ok((SELECT payment_status='pending_payment' AND paid_at IS NULL AND transaction_group_id IS NULL
                       FROM public.food_orders WHERE id=(SELECT (r->>'order_id')::uuid FROM t_res)), 'ORD-12 no payment evidence on the row');
SELECT food_test.ok((SELECT servings_reserved FROM public.food_menu_items WHERE id=pg_temp.v('mi')) = 1, 'ORD-13 stock reserved');
SELECT food_test.ok((SELECT (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi'), 'quantity', 1)),'k-a-1','cash'))->>'replayed')::boolean, 'ORD-14 same key replays');
SELECT food_test.ok((SELECT count(*) FROM public.food_orders WHERE idempotency_key='k-a-1') = 1, 'ORD-15 replay creates no second order');
SELECT food_test.ok((SELECT servings_reserved FROM public.food_menu_items WHERE id=pg_temp.v('mi')) = 1, 'ORD-16 replay reserves no extra stock');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',1)),'k-a-2','cash')$$, pg_temp.v('mi')), '22023', 'ORD-17 cap counts orders already held (3 held)');
-- employee B: cannot see A's order, cannot reuse A's key
SELECT food_test.act_as(food_test.id('emp_b'));
SELECT food_test.ok((SELECT count(*) FROM public.food_orders) = 0, 'ORD-20 employee B cannot see employee A order');
SELECT food_test.ok((SELECT count(*) FROM public.food_order_items) = 0, 'ORD-21 employee B cannot see A order lines');
SELECT food_test.raises(format($$SELECT public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L,'quantity',1)),'k-a-1','cash')$$, pg_temp.v('mi')), '22023', 'ORD-22 another employee key is refused, not replayed');
SELECT food_test.raises(format($$SELECT public.food_cancel_my_order(%L)$$, (SELECT (r->>'order_id')::uuid FROM t_res)), '42501', 'ORD-23 cannot cancel another employee order');
-- payment stays shut
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.raises(format($$SELECT public.food_pay_order(%L)$$, (SELECT (r->>'order_id')::uuid FROM t_res)), '0A000', 'PAY-01 food_pay_order refuses');
SELECT food_test.ok((SELECT payment_status FROM public.food_orders WHERE id=(SELECT (r->>'order_id')::uuid FROM t_res))='pending_payment', 'PAY-02 still unpaid after a pay attempt');
-- employee withdraws: stock released exactly once
SELECT public.food_cancel_my_order((SELECT (r->>'order_id')::uuid FROM t_res), 'test');
SELECT food_test.ok((SELECT servings_reserved FROM public.food_menu_items WHERE id=pg_temp.v('mi')) = 0, 'CAN-01 employee cancel releases stock');
SELECT food_test.raises(format($$SELECT public.food_cancel_my_order(%L)$$, (SELECT (r->>'order_id')::uuid FROM t_res)), '22023', 'CAN-02 second cancel refused');
SELECT food_test.ok((SELECT servings_reserved FROM public.food_menu_items WHERE id=pg_temp.v('mi')) = 0, 'CAN-03 no double release');
ROLLBACK;

-- ═════════════════ FUL: coordinator fulfilment and cancellation ═════════════════
BEGIN;
SELECT food_test.act_as(food_test.id('emp_a'));
CREATE TEMP TABLE t_o ON COMMIT DROP AS
  SELECT (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id', pg_temp.v('mi3'), 'quantity', 2)),'k-a-ful','cash')->>'order_id')::uuid AS id;
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((SELECT count(*) FROM public.food_orders) = 1, 'FUL-01 coordinator sees all orders');
SELECT food_test.raises(format($$SELECT public.food_set_fulfilment(%L,'ready')$$, (SELECT id FROM t_o)), '22023', 'FUL-02 confirmed -> ready refused');
SELECT public.food_set_fulfilment((SELECT id FROM t_o), 'cancelled', 'kitchen closed');
SELECT food_test.ok((SELECT servings_reserved FROM public.food_menu_items WHERE id=pg_temp.v('mi3')) = 0, 'FUL-03 coordinator cancel releases stock (R2)');
SELECT food_test.raises(format($$SELECT public.food_set_fulfilment(%L,'cancelled')$$, (SELECT id FROM t_o)), '22023', 'FUL-04 cancelled is terminal');
SELECT food_test.ok((SELECT count(*) FROM public.food_audit WHERE entity='order' AND entity_id=(SELECT id FROM t_o)) = 1, 'FUL-05 fulfilment change is audited');
ROLLBACK;

-- ═════════════════ COO: coordinator handover (R4) ═════════════════
BEGIN;
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises(format($$SELECT public.food_transfer_coordinator(%L,'full_transfer','handover to tenant')$$, food_test.id('tenant')), 'P0002', 'COO-01 handover to a non-employee refused');
SELECT food_test.raises(format($$SELECT public.food_transfer_coordinator(%L,'full_transfer','handover to disabled')$$, food_test.id('emp_off')), 'P0002', 'COO-02 handover to a disabled employee refused');
SELECT food_test.raises(format($$SELECT public.food_transfer_coordinator(%L,'full_transfer','handover to deleted')$$, food_test.id('emp_gone')), 'P0002', 'COO-03 handover to a deleted profile refused');
SELECT food_test.raises($$SELECT public.food_transfer_coordinator(gen_random_uuid(),'full_transfer','handover to nobody')$$, 'P0002', 'COO-04 handover to a missing profile refused');
SELECT food_test.raises(format($$SELECT public.food_transfer_coordinator(%L,'full_transfer','short')$$, food_test.id('emp_ok')), '22023', 'COO-05 short reason refused');
SELECT food_test.ok(NOT EXISTS (SELECT 1 FROM public.food_coordinator_candidates() c WHERE c.user_id IN (food_test.id('tenant'), food_test.id('emp_off'), food_test.id('emp_gone'), food_test.id('coord'))), 'COO-06 candidates exclude ineligible and self');
SELECT public.food_transfer_coordinator(food_test.id('emp_ok'), 'transfer_with_backup', 'planned handover for test');
RESET ROLE;
SELECT food_test.ok((SELECT count(*) FROM public.food_coordinator_assignments WHERE revoked_at IS NULL AND access_level='active') = 1
                AND (SELECT coordinator_id FROM public.food_coordinator_assignments WHERE revoked_at IS NULL AND access_level='active') = food_test.id('emp_ok'), 'COO-07 exactly one active coordinator after handover');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.ok((SELECT count(*) FROM public.food_orders) >= 0 AND public.is_food_coordinator(auth.uid()) AND NOT public.is_active_food_coordinator(auth.uid()), 'COO-08 outgoing holder keeps backup (read) access');
SELECT food_test.raises($$SELECT public.food_upsert_meal(NULL,'Backup edit',NULL,NULL,1)$$, '42501', 'COO-09 backup holder cannot author');
ROLLBACK;

-- ═════════════════ EXC: exception resolution ═════════════════
BEGIN;
INSERT INTO public.food_exceptions (kind, detail) VALUES ('OTHER', '{"note":"x"}');
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises(format($$SELECT public.food_resolve_exception(%L, '   ')$$, (SELECT id FROM public.food_exceptions LIMIT 1)), '22023', 'EXC-01 blank reason refused');
SELECT public.food_resolve_exception((SELECT id FROM public.food_exceptions LIMIT 1), 'handled at the counter');
SELECT food_test.raises(format($$SELECT public.food_resolve_exception(%L, 'again')$$, (SELECT id FROM public.food_exceptions LIMIT 1)), '22023', 'EXC-02 resolved exception is not re-resolved');
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.raises($$SELECT public.food_resolve_exception(gen_random_uuid(), 'x')$$, '42501', 'EXC-03 employee cannot resolve');
ROLLBACK;

-- ═════════════════ INT: append-only and money isolation ═════════════════
BEGIN;
SELECT food_test.raises($$DELETE FROM public.food_audit$$, 'P0001', 'INT-01 audit is append-only even for the owner');
SELECT food_test.ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND (p.proname LIKE 'food\_%' OR p.proname LIKE '%food\_coordinator%')
     -- statements that would touch money; comments and messages mention
     -- "wallet" deliberately and are not matched
     AND p.prosrc ~* '(from|join|into|update)\s+(public\.)?(general_ledger|wallets?|wallet_\w+|ledger_\w+|agent_\w+)\b|create_ledger_transaction\s*\('),
  'INT-02 no food function reads or writes the ledger or wallets');
ROLLBACK;
