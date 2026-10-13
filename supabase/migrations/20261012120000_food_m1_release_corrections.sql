-- Food M1 — release corrections.
--
-- NOT APPLIED TO PRODUCTION. Applies on top of 20261009120001, 20261009130001,
-- 20261009160000 and 20261009170000, in that order.
--
-- NO MONEY MOVES IN THIS MIGRATION OR ANYTHING IT DEFINES. No wallet, balance,
-- general-ledger or ledger_account_map object is read or written; no ledger
-- category is created. food_pay_order stays disabled.
--
-- DECISIONS IMPLEMENTED (CFO, 2026-10-12):
--   D1  An employee selects a payment mode when placing an order: cash, wallet
--       or mobile_money. The mode is RECORDED ONLY. Placing an order never
--       debits a wallet, transfers money, posts to the ledger or marks the
--       order paid. A wallet payment would move money, so wallet settlement
--       remains disabled until a separately approved design exists.
--   D2  Payment is made after delivery only. The kitchen therefore prepares,
--       readies and hands over UNPAID orders; payment_status stays
--       'pending_payment' throughout and is reported on every row.
--   D3  Defensive bounds: at most 20 servings of one menu item per order, and
--       special instructions of at most 500 characters.
--
-- DEFECTS CORRECTED (Food M1 master problem register, 2026-10-12):
--   FM-06  'preparing' required payment_status = 'paid', which nothing can set,
--          so no order could ever move past 'confirmed' in production.
--   FM-07  Preparation list and overview counted paid orders only, so the
--          kitchen view stayed empty.
--   FM-09  A service day could be closed while unpaid orders were still live,
--          stranding them as 'confirmed' on a closed day.
--   FM-10  The employee menu listed a scheduled meal after it was archived;
--          ordering it then failed.
--   FM-11  No upper bound on line quantity or instruction length.
--   FM-12  is_food_coordinator(any uuid) let any employee probe another
--          person's coordinator status.
--   FM-13  SECURITY DEFINER food functions had search_path = public without
--          pg_temp pinned last.
--   FM-14  Coordinator screens could not show whose order is whose, nor who
--          held the coordinator role, because profiles are not readable to
--          them. food_people_names returns names for food participants only.
--   FM-15  Any signed-in account (tenant, agent, landlord, supporter) could
--          read the canteen menu and place orders. Now staff (an enabled
--          'employee' role) and Food Coordinators only. food_can_use_canteen()
--          tells the client (self only) whether to offer the canteen.
--   FM-17  20261009120001 required a specific production profile to exist.
--          Its seed is now conditional; food_bootstrap_coordinator() (service
--          role only) appoints the first coordinator where nobody is seated.
--   FM-21  Nothing could create a food exception. food_raise_exception():
--          the active coordinator, or an employee about their own order.
--   FM-23  food_place_order used a session temp table inside a definer
--          function; the basket is now held in local arrays.
--
-- ROLLBACK, in one transaction:
--   1. DROP FUNCTION food_place_order(jsonb,text,text,text),
--      food_people_names(uuid[]), food_raise_exception(text,text,uuid),
--      food_bootstrap_coordinator(uuid,text), food_can_use_canteen(),
--      food_require_canteen_user(), food_is_canteen_user(uuid);
--      DROP POLICY food_exc_read_own, TRIGGER food_exceptions_no_delete,
--      INDEX food_exceptions_one_open_employee_report and
--      food_exceptions_open_idx, the two food_exceptions constraints and the
--      raised_by / raised_via columns (raised exceptions themselves remain);
--   2. re-apply 20261009120001's two is_*_food_coordinator definitions and
--      all of 20261009130001 (restores the three-argument food_place_order and
--      every replaced function with its grants);
--   3. re-apply 20261009160000 and 20261009170000 (restores their search_path);
--   4. DROP the payment_mode constraints and column, and recreate
--      food_orders_queue_idx as (service_date, fulfilment_status) WHERE
--      payment_status = 'paid'.
-- Dropping the column discards recorded payment modes and nothing else; no
-- money, wallet or ledger state exists to reverse.

-- ═══════════════ D1: payment mode, recorded only ═══════════════

ALTER TABLE public.food_orders ADD COLUMN IF NOT EXISTS payment_mode text;

ALTER TABLE public.food_orders
  ADD CONSTRAINT food_orders_payment_mode_known
  CHECK (payment_mode IS NULL OR payment_mode IN ('cash', 'wallet', 'mobile_money'));

-- Required on every order placed from now on. NOT VALID so that orders placed
-- in a test project before this migration do not block it; PostgreSQL still
-- enforces the constraint on every new INSERT and UPDATE.
ALTER TABLE public.food_orders
  ADD CONSTRAINT food_orders_payment_mode_required
  CHECK (payment_mode IS NOT NULL) NOT VALID;

COMMENT ON COLUMN public.food_orders.payment_mode IS
  'How the employee intends to pay after delivery: cash, wallet or mobile_money. '
  'Recorded only. It never moves money and never changes payment_status.';

-- The kitchen queue is no longer limited to paid orders.
DROP INDEX IF EXISTS public.food_orders_queue_idx;
CREATE INDEX food_orders_queue_idx ON public.food_orders (service_date, fulfilment_status);

-- ═══════════════ FM-12: coordinator status is not probeable ═══════════════
-- A signed-in user may ask about themselves only. Service-side callers with no
-- JWT (auth.uid() IS NULL) keep the full answer. Every RLS policy and RPC in
-- this feature already passes auth.uid(), so their behaviour is unchanged.

CREATE OR REPLACE FUNCTION public.is_food_coordinator(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (auth.uid() IS NULL OR _user_id = auth.uid())
     AND EXISTS (
       SELECT 1 FROM public.food_coordinator_assignments a
        WHERE a.coordinator_id = _user_id AND a.revoked_at IS NULL);
$$;

CREATE OR REPLACE FUNCTION public.is_active_food_coordinator(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (auth.uid() IS NULL OR _user_id = auth.uid())
     AND EXISTS (
       SELECT 1 FROM public.food_coordinator_assignments a
        WHERE a.coordinator_id = _user_id AND a.revoked_at IS NULL
          AND a.access_level = 'active');
$$;

-- ═══════════════ FM-10: archived meals leave the menu ═══════════════

CREATE OR REPLACE FUNCTION public.food_menu_for_day(p_service_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid();
        v_day date := COALESCE(p_service_date, (now() AT TIME ZONE 'Africa/Kampala')::date);
        v_now time := (now() AT TIME ZONE 'Africa/Kampala')::time;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  PERFORM public.food_require_canteen_user();   -- FM-15: staff and coordinators only

  RETURN jsonb_build_object(
    'service_date', v_day,
    'closed', EXISTS (SELECT 1 FROM public.food_service_closures WHERE closure_date=v_day),
    'checkout_enabled', false,   -- settlement is disabled; payment is after delivery
    'payment_modes', jsonb_build_array('cash', 'wallet', 'mobile_money'),
    'max_qty_per_line', 20,
    'max_instructions_length', 500,
    'periods', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'period_id', sp.id, 'name', sp.name,
        'ordering_opens_at', sp.ordering_opens_at,
        'ordering_closes_at', sp.ordering_closes_at,
        'ordering_open', (v_now BETWEEN sp.ordering_opens_at AND sp.ordering_closes_at)
                          AND v_day = (now() AT TIME ZONE 'Africa/Kampala')::date,
        'collection_instructions', sp.collection_instructions,
        'max_qty_per_employee', sp.max_qty_per_employee,
        'meals', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'menu_item_id', mi.id, 'meal_id', m.id, 'name', m.name,
            'description', m.description, 'image_path', m.image_path,
            'category', c.name, 'price_ugx', mi.price_ugx,
            'servings_total', mi.servings_total,
            'servings_remaining', CASE WHEN mi.servings_total IS NULL THEN NULL
                                       ELSE mi.servings_total - mi.servings_reserved END,
            'sold_out', mi.sold_out OR (mi.servings_total IS NOT NULL
                                        AND mi.servings_reserved >= mi.servings_total))
            ORDER BY c.sort_order NULLS LAST, m.name)
          FROM public.food_menu_items mi
          JOIN public.food_meals m ON m.id=mi.meal_id
          LEFT JOIN public.food_categories c ON c.id=m.category_id
          WHERE mi.service_date=v_day AND mi.period_id=sp.id AND mi.published_at IS NOT NULL
            AND m.status = 'published'          -- FM-10: never list an unorderable meal
        ), '[]'::jsonb))
        ORDER BY sp.ordering_opens_at)
      FROM public.food_service_periods sp WHERE sp.active
    ), '[]'::jsonb));
END $$;

-- ═══════════════ D1, D3: placing an order ═══════════════
-- The three-argument form is replaced, not overloaded: a leftover overload
-- would still accept an order with no payment mode.
DROP FUNCTION IF EXISTS public.food_place_order(jsonb, text, text);

CREATE FUNCTION public.food_place_order(
  p_items jsonb, p_idempotency_key text, p_payment_mode text,
  p_special_instructions text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_now time := (now() AT TIME ZONE 'Africa/Kampala')::time;
  v_id uuid; v_ref text; v_date date; v_period uuid; v_total numeric(14,2) := 0;
  v_existing public.food_orders%ROWTYPE;
  v_max int; v_already int; v_asked int; it jsonb; v_mi record;
  v_notes text := nullif(btrim(p_special_instructions), '');
  -- FM-23: the basket lives in two local arrays (ids ascending, quantities
  -- aligned), never in a session temp table that a caller could pre-create.
  v_ids uuid[]; v_qtys int[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  PERFORM public.food_require_canteen_user();   -- FM-15: staff and coordinators only
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key))=0 THEN
    RAISE EXCEPTION 'An idempotency key is required' USING ERRCODE='22023'; END IF;
  IF length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'The idempotency key is too long' USING ERRCODE='22023'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items)=0 THEN
    RAISE EXCEPTION 'Your order is empty' USING ERRCODE='22023'; END IF;

  -- Replaying the same key returns the original order rather than a second one.
  -- Checked before the payment mode so a retry is never refused for a field the
  -- original order already recorded.
  SELECT * INTO v_existing FROM public.food_orders WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.employee_id <> v_uid THEN
      RAISE EXCEPTION 'That order reference is already in use' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('order_id', v_existing.id, 'order_reference', v_existing.order_reference,
      'total_ugx', v_existing.total_ugx, 'payment_status', v_existing.payment_status,
      'payment_mode', v_existing.payment_mode, 'replayed', true);
  END IF;

  -- D1: the employee's declared way of paying after delivery. Recorded only.
  IF p_payment_mode IS NULL OR p_payment_mode NOT IN ('cash', 'wallet', 'mobile_money') THEN
    RAISE EXCEPTION 'Choose how you will pay: cash, wallet or mobile money' USING ERRCODE='22023'; END IF;

  -- D3: instruction length
  IF length(v_notes) > 500 THEN
    RAISE EXCEPTION 'Special instructions can be at most 500 characters' USING ERRCODE='22023'; END IF;

  -- validate every line's shape before anything is cast
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(it) <> 'object' OR (it->>'menu_item_id') IS NULL
       OR (it->>'menu_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Every line needs a menu item' USING ERRCODE='22023'; END IF;
    IF (it->>'quantity') IS NULL OR (it->>'quantity') !~ '^[0-9]{1,6}$'
       OR (it->>'quantity')::int <= 0 THEN
      RAISE EXCEPTION 'Every line needs a quantity of at least 1' USING ERRCODE='22023'; END IF;
  END LOOP;

  -- collapse duplicate lines for the same meal; ids ascending (the lock order)
  SELECT array_agg(menu_item_id ORDER BY menu_item_id), array_agg(qty ORDER BY menu_item_id)
    INTO v_ids, v_qtys
    FROM (SELECT (e->>'menu_item_id')::uuid AS menu_item_id, SUM((e->>'quantity')::int)::int AS qty
            FROM jsonb_array_elements(p_items) e GROUP BY 1) s;

  -- D3: at most 20 servings of one menu item, after duplicate lines are merged
  IF EXISTS (SELECT 1 FROM unnest(v_qtys) q WHERE q > 20) THEN
    RAISE EXCEPTION 'You can order at most 20 servings of one meal' USING ERRCODE='22023'; END IF;

  -- Validate, and lock each menu row in a stable order (id) so two employees
  -- racing for the last servings cannot deadlock against each other.
  -- An unknown menu item is caught first: a row lock cannot be taken on the
  -- nullable side of an outer join, so the locking read below must be an
  -- INNER join and every basket line has to be known to exist by then.
  IF EXISTS (SELECT 1 FROM unnest(v_ids) b(menu_item_id)
              LEFT JOIN public.food_menu_items mi ON mi.id = b.menu_item_id
             WHERE mi.id IS NULL) THEN
    RAISE EXCEPTION 'One of the meals is no longer on the menu' USING ERRCODE='P0002'; END IF;

  FOR v_mi IN
    SELECT b.menu_item_id, b.quantity, mi.service_date, mi.period_id, mi.meal_id,
           mi.price_ugx, mi.sold_out, mi.published_at,
           m.name, m.description, m.status
      FROM unnest(v_ids, v_qtys) b(menu_item_id, quantity)
      JOIN public.food_menu_items mi ON mi.id = b.menu_item_id
      JOIN public.food_meals m ON m.id = mi.meal_id
     ORDER BY b.menu_item_id
     FOR NO KEY UPDATE OF mi
  LOOP
    IF v_mi.published_at IS NULL OR v_mi.status <> 'published' THEN
      RAISE EXCEPTION 'Meal "%" is not available to order', COALESCE(v_mi.name,'?') USING ERRCODE='22023'; END IF;
    IF v_mi.sold_out THEN
      RAISE EXCEPTION 'Meal "%" is sold out', v_mi.name USING ERRCODE='22023'; END IF;

    IF v_date IS NULL THEN v_date := v_mi.service_date; v_period := v_mi.period_id; END IF;
    IF v_mi.service_date <> v_date OR v_mi.period_id <> v_period THEN
      RAISE EXCEPTION 'An order cannot mix service periods or dates' USING ERRCODE='22023'; END IF;

    v_total := v_total + round(v_mi.price_ugx * v_mi.quantity, 2);
  END LOOP;

  -- the day must be open and the ordering window still running
  IF EXISTS (SELECT 1 FROM public.food_service_closures WHERE closure_date = v_date) THEN
    RAISE EXCEPTION 'Food service is closed on %', v_date USING ERRCODE='22023'; END IF;
  IF v_date <> v_today THEN
    RAISE EXCEPTION 'Orders can only be placed for today' USING ERRCODE='22023'; END IF;
  SELECT max_qty_per_employee INTO v_max FROM public.food_service_periods
   WHERE id = v_period AND active
     AND v_now BETWEEN ordering_opens_at AND ordering_closes_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ordering for this service period is closed' USING ERRCODE='22023'; END IF;

  -- Per-employee cap across everything they already hold for this period.
  -- Serialised per (employee, service period) by a transaction advisory lock,
  -- taken AFTER the menu-row locks above and never before them, so no lock
  -- cycle can form. Rationale unchanged from 20261009130001.
  IF v_max IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtext('food_place_order_cap'),
      hashtext(v_uid::text || ':' || v_period::text));

    SELECT COALESCE(SUM(oi.quantity),0) INTO v_already
      FROM public.food_orders o JOIN public.food_order_items oi ON oi.order_id = o.id
     WHERE o.employee_id = v_uid AND o.service_date = v_date AND o.period_id = v_period
       AND o.fulfilment_status <> 'cancelled';
    SELECT COALESCE(SUM(q),0) INTO v_asked FROM unnest(v_qtys) q;
    IF v_already + v_asked > v_max THEN
      RAISE EXCEPTION 'You can order at most % item(s) for this service period, and you already have %',
        v_max, v_already USING ERRCODE='22023'; END IF;
  END IF;

  v_id  := gen_random_uuid();
  v_ref := 'FO-' || to_char(now() AT TIME ZONE 'Africa/Kampala','YYMMDD') || '-' ||
           upper(substr(replace(v_id::text,'-',''),1,6));

  -- NO PAYMENT HAPPENS HERE. The order is created unpaid with the employee's
  -- declared payment mode: no wallet is read or debited, no money is
  -- transferred, no ledger entry is written and the order is not marked paid.
  --
  -- CONCURRENT REPLAY: two simultaneous submissions of one key both miss the
  -- unlocked read above; the unique index lets one INSERT win, and the loser
  -- re-reads and replays (READ COMMITTED) or gets 40001 (snapshot isolation).
  -- Behaviour and rationale unchanged from 20261009130001; verified by the R3
  -- two-session suite.
  BEGIN
    INSERT INTO public.food_orders (id, order_reference, employee_id, service_date, period_id,
           total_ugx, payment_status, fulfilment_status, idempotency_key, special_instructions,
           payment_mode)
    VALUES (v_id, v_ref, v_uid, v_date, v_period, v_total, 'pending_payment', 'confirmed',
            p_idempotency_key, v_notes, p_payment_mode);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM public.food_orders
     WHERE idempotency_key = p_idempotency_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Your order could not be confirmed because another request was in flight. Please try again.'
        USING ERRCODE = '40001',
              HINT = 'No order was created by this request.';
    END IF;

    IF v_existing.employee_id <> v_uid THEN
      RAISE EXCEPTION 'That order reference is already in use' USING ERRCODE='22023';
    END IF;

    RETURN jsonb_build_object('order_id', v_existing.id, 'order_reference', v_existing.order_reference,
      'total_ugx', v_existing.total_ugx, 'payment_status', v_existing.payment_status,
      'payment_mode', v_existing.payment_mode, 'replayed', true);
  END;

  INSERT INTO public.food_order_items (order_id, menu_item_id, meal_id, meal_name,
         meal_description, unit_price_ugx, quantity, line_total_ugx)
  -- Snapshots: the price comes from the menu rows locked above (so the lines
  -- always sum to v_total); name and description from the meal.
  SELECT v_id, b.menu_item_id, mi.meal_id, m.name, m.description,
         mi.price_ugx, b.quantity, round(mi.price_ugx * b.quantity, 2)
    FROM unnest(v_ids, v_qtys) b(menu_item_id, quantity)
    JOIN public.food_menu_items mi ON mi.id = b.menu_item_id
    JOIN public.food_meals m ON m.id = mi.meal_id;

  -- Reserve the servings. The within-stock CHECK is what actually prevents an
  -- oversell; the row locks above make the read-then-write safe under contention.
  BEGIN
    UPDATE public.food_menu_items mi
       SET servings_reserved = mi.servings_reserved + b.quantity
      FROM unnest(v_ids, v_qtys) b(menu_item_id, quantity)
     WHERE mi.id = b.menu_item_id;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'Not enough servings left for that quantity' USING ERRCODE='22023';
  END;

  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (v_id, 'placed', NULL, 'confirmed',
          'Unpaid order placed; payment mode ' || p_payment_mode || ', payable after delivery', v_uid);

  RETURN jsonb_build_object('order_id', v_id, 'order_reference', v_ref,
    'total_ugx', v_total, 'payment_status', 'pending_payment',
    'payment_mode', p_payment_mode, 'replayed', false);
END $$;

-- ═══════════════ D2, FM-06: fulfilment does not wait for payment ═══════════════

CREATE OR REPLACE FUNCTION public.food_set_fulfilment(
  p_order_id uuid, p_to_status text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator();
        v_from text; v_released boolean; v_ok boolean;
BEGIN
  -- FOR UPDATE serialises concurrent changes to one order; the second caller
  -- re-reads the new state and the terminal-state guard refuses it, so the
  -- reservation can only ever be released once.
  SELECT fulfilment_status, stock_released INTO v_from, v_released
    FROM public.food_orders WHERE id=p_order_id FOR UPDATE;
  IF v_from IS NULL THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;

  IF v_from IN ('collected','delivered','cancelled') THEN
    RAISE EXCEPTION 'Order is already % and cannot be changed here', v_from USING ERRCODE='22023';
  END IF;

  v_ok := CASE
    WHEN v_from='confirmed' AND p_to_status IN ('preparing','cancelled') THEN true
    WHEN v_from='preparing' AND p_to_status IN ('ready','cancelled')     THEN true
    WHEN v_from='ready'     AND p_to_status IN ('collected','delivered') THEN true
    ELSE false END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Invalid transition % -> %', v_from, p_to_status USING ERRCODE='22023'; END IF;

  -- D2: payment is made after delivery, so no transition here depends on
  -- payment_status, and none of them changes it. payment_status is not read,
  -- not written and stays exactly as it was.

  IF p_to_status = 'cancelled' THEN
    UPDATE public.food_orders
       SET fulfilment_status = p_to_status, cancelled_at = now(), stock_released = true
     WHERE id = p_order_id;
    -- stock_released, read under the row lock, is the exactly-once guard.
    IF NOT v_released THEN
      UPDATE public.food_menu_items mi
         SET servings_reserved = GREATEST(mi.servings_reserved - oi.quantity, 0)
        FROM public.food_order_items oi
       WHERE oi.order_id = p_order_id AND mi.id = oi.menu_item_id;
    END IF;
  ELSE
    UPDATE public.food_orders SET fulfilment_status=p_to_status WHERE id=p_order_id;
  END IF;

  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (p_order_id, 'fulfilment', v_from, p_to_status, p_note, v_actor);
  PERFORM public.food_audit_write('order', p_order_id, 'fulfilment_'||p_to_status,
    jsonb_build_object('from',v_from), jsonb_build_object('to',p_to_status), p_note, v_actor);

  RETURN jsonb_build_object('order_id',p_order_id,'from',v_from,'to',p_to_status);
END $$;

-- Settlement stays disabled. When a payment process is approved it must also
-- refuse any order that is not yet collected or delivered (D2).
CREATE OR REPLACE FUNCTION public.food_pay_order(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FOOD_CHECKOUT_DISABLED: paying for a meal is not enabled yet. Payment is made after delivery, through a process that has not been approved.'
    USING ERRCODE='0A000',
          HINT='The order is unaffected and no wallet was read or debited.';
END $$;

-- ═══════════════ FM-07: overview and kitchen list include unpaid orders ═══════════════

CREATE OR REPLACE FUNCTION public.food_coordinator_overview(p_service_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_day date := COALESCE(p_service_date, (now() AT TIME ZONE 'Africa/Kampala')::date);
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_food_coordinator(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised to view Food Management' USING ERRCODE='42501'; END IF;

  RETURN jsonb_build_object(
    'service_date', v_day,
    'checkout_enabled', false,
    -- D2: payment is after delivery, so the kitchen never waits for it.
    'fulfilment_requires_payment', false,
    'menu_published', (SELECT count(*) FROM public.food_menu_items
                        WHERE service_date=v_day AND published_at IS NOT NULL),
    'orders_today',   (SELECT count(*) FROM public.food_orders WHERE service_date=v_day),
    -- counts of orders, not money figures
    'unpaid_orders',  (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND payment_status='pending_payment'
                          AND fulfilment_status <> 'cancelled'),
    'unpaid_handed_over', (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND payment_status='pending_payment'
                          AND fulfilment_status IN ('collected','delivered')),
    'awaiting_prep',  (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND fulfilment_status='confirmed'),
    'preparing',      (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND fulfilment_status='preparing'),
    'ready',          (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND fulfilment_status='ready'),
    'completed',      (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND fulfilment_status IN ('collected','delivered')),
    'cancelled',      (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND fulfilment_status='cancelled'),
    'by_payment_mode', (SELECT COALESCE(jsonb_object_agg(pm, n), '{}'::jsonb) FROM (
                          SELECT payment_mode AS pm, count(*) AS n FROM public.food_orders
                           WHERE service_date=v_day AND fulfilment_status <> 'cancelled'
                             AND payment_mode IS NOT NULL
                           GROUP BY payment_mode) s),
    'open_exceptions',(SELECT count(*) FROM public.food_exceptions WHERE resolved_at IS NULL),
    -- an order total, NOT accounting revenue; no accounting treatment is approved
    'paid_order_total_ugx', (SELECT COALESCE(SUM(total_ugx),0) FROM public.food_orders
                              WHERE service_date=v_day AND payment_status='paid'));
END $$;

-- Consolidated kitchen list: every live (non-cancelled) order, paid or not.
CREATE OR REPLACE FUNCTION public.food_preparation_list(
  p_service_date date DEFAULT NULL, p_period_id uuid DEFAULT NULL)
RETURNS TABLE (meal_name text, total_quantity bigint, order_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_day date := COALESCE(p_service_date, (now() AT TIME ZONE 'Africa/Kampala')::date);
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_food_coordinator(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501'; END IF;
  RETURN QUERY
    SELECT oi.meal_name, SUM(oi.quantity)::bigint, count(DISTINCT o.id)::bigint
      FROM public.food_orders o
      JOIN public.food_order_items oi ON oi.order_id=o.id
     WHERE o.service_date=v_day
       AND (p_period_id IS NULL OR o.period_id=p_period_id)
       AND o.fulfilment_status IN ('confirmed','preparing')
     GROUP BY oi.meal_name ORDER BY 2 DESC;
END $$;

-- ═══════════════ FM-09: never strand a live order on a closed day ═══════════════

CREATE OR REPLACE FUNCTION public.food_set_closure(
  p_closure_date date, p_closed boolean, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator(); v_n int;
BEGIN
  IF p_closed THEN
    IF p_reason IS NULL OR length(btrim(p_reason))=0 THEN
      RAISE EXCEPTION 'A reason is required to close a service day' USING ERRCODE='22023'; END IF;
    -- Any live order, paid or not: with payment after delivery, an unpaid
    -- order is still an employee expecting food.
    SELECT count(*) INTO v_n FROM public.food_orders
     WHERE service_date=p_closure_date
       AND fulfilment_status IN ('confirmed','preparing','ready');
    IF v_n > 0 THEN
      RAISE EXCEPTION 'Cannot close %: % order(s) are still live. Hand them over or cancel them first.',
        p_closure_date, v_n USING ERRCODE='22023'; END IF;

    INSERT INTO public.food_service_closures (closure_date, reason, created_by)
    VALUES (p_closure_date, btrim(p_reason), v_actor)
    ON CONFLICT (closure_date) DO UPDATE SET reason=EXCLUDED.reason;
    PERFORM public.food_audit_write('closure', NULL, 'closed', NULL,
      jsonb_build_object('date',p_closure_date), p_reason, v_actor);
  ELSE
    DELETE FROM public.food_service_closures WHERE closure_date=p_closure_date;
    PERFORM public.food_audit_write('closure', NULL, 'reopened', NULL,
      jsonb_build_object('date',p_closure_date), p_reason, v_actor);
  END IF;
END $$;

-- ═══════════════ FM-14: names for the coordinator screens ═══════════════
-- Returns id and display name ONLY, and only for people who appear in this
-- feature: an employee who has placed a food order, or a party to a
-- coordinator assignment. Anyone else's id returns nothing, so this cannot be
-- used to read the staff directory. Coordinator (active or backup) only.

CREATE FUNCTION public.food_people_names(p_ids uuid[])
RETURNS TABLE (user_id uuid, full_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_food_coordinator(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501'; END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN; END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'Ask for at most 500 names at a time' USING ERRCODE='22023'; END IF;

  RETURN QUERY
    SELECT p.id, coalesce(nullif(btrim(p.full_name), ''), 'Staff member')
      FROM public.profiles p
     WHERE p.id = ANY (p_ids)
       AND (EXISTS (SELECT 1 FROM public.food_orders o WHERE o.employee_id = p.id)
            OR EXISTS (SELECT 1 FROM public.food_coordinator_assignments a
                        WHERE p.id IN (a.coordinator_id, a.assigned_by, a.revoked_by)));
END $$;

-- ═══════════════ FM-15: only staff may use the canteen ═══════════════
-- Before this, ANY signed-in account (tenant, agent, landlord, supporter)
-- could read the canteen menu and place orders: the route guard checks only
-- that someone is signed in, and the RPCs checked nothing more.
--
-- "Staff" is the same authoritative test food_transfer_coordinator and
-- food_coordinator_candidates already apply: an ENABLED 'employee' role in
-- user_roles. A Food Coordinator (active or backup) is also admitted, so the
-- coordinator's own menu screen keeps working whatever their role row says.
-- Internal helper: not granted to anyone; called only from definer RPCs.

CREATE FUNCTION public.food_is_canteen_user(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT _user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.user_roles ur
             JOIN public.profiles p ON p.id = ur.user_id
            WHERE ur.user_id = _user_id
              AND ur.role = 'employee'::public.app_role
              AND COALESCE(ur.enabled, true)
              AND p.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.food_coordinator_assignments a
                WHERE a.coordinator_id = _user_id AND a.revoked_at IS NULL));
$$;
REVOKE ALL ON FUNCTION public.food_is_canteen_user(uuid) FROM PUBLIC, anon, authenticated;

-- Wraps the menu read and order placement defined above. Done as a guard at
-- the top of each body rather than a second copy of either function.
CREATE OR REPLACE FUNCTION public.food_require_canteen_user()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v uuid := auth.uid();
BEGIN
  IF v IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF NOT public.food_is_canteen_user(v) THEN
    RAISE EXCEPTION 'The canteen is for Welile staff only' USING ERRCODE='42501';
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.food_require_canteen_user() FROM PUBLIC, anon, authenticated;

-- Lets the client decide whether to offer the canteen at all (navigation).
-- Answers for the caller only; it reveals nothing about anyone else.
CREATE FUNCTION public.food_can_use_canteen()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.food_is_canteen_user(auth.uid());
$$;

-- ═══════════════ FM-17: appointing the first coordinator ═══════════════
-- 20261009120001 now seeds its coordinator only when that profile exists. On a
-- database where it does not, nobody is seated and the feature cannot be
-- managed. This appoints the FIRST coordinator, server-side only:
--   * EXECUTE for service_role only — never for a signed-in user, so nobody
--     can appoint themselves through the API;
--   * refuses while any active coordinator is seated (use the handover then);
--   * the appointee must pass the same eligibility test as a handover;
--   * a reason of at least 10 characters, recorded in the append-only audit.

CREATE FUNCTION public.food_bootstrap_coordinator(p_user_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.food_coordinator_assignments
              WHERE revoked_at IS NULL AND access_level = 'active') THEN
    RAISE EXCEPTION 'A Food Coordinator is already seated; use the handover instead'
      USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = p_user_id AND p.deleted_at IS NULL
                    AND EXISTS (SELECT 1 FROM public.user_roles ur
                                 WHERE ur.user_id = p.id
                                   AND ur.role = 'employee'::public.app_role
                                   AND COALESCE(ur.enabled, true))) THEN
    RAISE EXCEPTION 'The appointee is not an eligible employee account' USING ERRCODE='P0002'; END IF;

  -- the partial unique index food_one_active_coordinator settles a race between
  -- two bootstrap calls: exactly one INSERT can succeed
  INSERT INTO public.food_coordinator_assignments (coordinator_id, access_level, assigned_by, reason)
  VALUES (p_user_id, 'active', NULL, v_reason);

  PERFORM public.food_audit_write('coordinator', p_user_id, 'bootstrap_appointed', NULL,
    jsonb_build_object('to', p_user_id), v_reason, p_user_id);
  RETURN jsonb_build_object('status', 'appointed', 'coordinator_id', p_user_id);
END $$;

-- ═══════════════ FM-21: raising a food exception ═══════════════
-- Exceptions are an OPERATIONAL log only: they never touch payment status,
-- money, a wallet or the ledger, and never change an order's status.
-- CFO decision 2026-10-12:
--   * the ACTIVE Food Coordinator may log an exception, against an order or not;
--   * an EMPLOYEE may report a problem with their OWN order only, one open
--     report per order at a time;
--   * kinds — the nine approved codes: MISSING_ITEM, WRONG_ITEM,
--     QUALITY_ISSUE, LATE_DELIVERY, NOT_DELIVERED, DAMAGED_ORDER,
--     STOCK_UNAVAILABLE, ORDER_ERROR, OTHER; a description (<= 500 chars) is
--     mandatory.

ALTER TABLE public.food_exceptions ADD COLUMN IF NOT EXISTS raised_by uuid REFERENCES public.profiles(id);
ALTER TABLE public.food_exceptions ADD COLUMN IF NOT EXISTS raised_via text;
ALTER TABLE public.food_exceptions
  ADD CONSTRAINT food_exceptions_raised_via_known
  CHECK (raised_via IS NULL OR raised_via IN ('coordinator', 'employee'));
-- NOT VALID: rows written before this migration (test projects only) keep
-- whatever kind they had; every new or updated row must use a known kind.
ALTER TABLE public.food_exceptions
  ADD CONSTRAINT food_exceptions_kind_known
  CHECK (kind IN ('MISSING_ITEM', 'WRONG_ITEM', 'QUALITY_ISSUE', 'LATE_DELIVERY', 'NOT_DELIVERED', 'DAMAGED_ORDER', 'STOCK_UNAVAILABLE', 'ORDER_ERROR', 'OTHER')) NOT VALID;

CREATE UNIQUE INDEX food_exceptions_one_open_employee_report
  ON public.food_exceptions (order_id, raised_by)
  WHERE resolved_at IS NULL AND raised_via = 'employee';
CREATE INDEX food_exceptions_open_idx
  ON public.food_exceptions (created_at DESC) WHERE resolved_at IS NULL;

-- The original evidence is never deleted.
CREATE TRIGGER food_exceptions_no_delete BEFORE DELETE ON public.food_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.food_no_hard_delete();

-- An employee may read the reports they raised (and how they were resolved).
CREATE POLICY food_exc_read_own ON public.food_exceptions FOR SELECT TO authenticated
  USING (raised_by = auth.uid());

CREATE FUNCTION public.food_raise_exception(
  p_kind text, p_note text, p_order_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_note text := btrim(coalesce(p_note, ''));
  v_coord boolean;
  v_owner uuid;
  v_row public.food_exceptions%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  PERFORM public.food_require_canteen_user();

  IF p_kind IS NULL OR p_kind NOT IN ('MISSING_ITEM', 'WRONG_ITEM', 'QUALITY_ISSUE', 'LATE_DELIVERY', 'NOT_DELIVERED', 'DAMAGED_ORDER', 'STOCK_UNAVAILABLE', 'ORDER_ERROR', 'OTHER') THEN
    RAISE EXCEPTION 'Unknown exception kind' USING ERRCODE='22023'; END IF;
  IF v_note = '' THEN
    RAISE EXCEPTION 'Describe the problem' USING ERRCODE='22023'; END IF;
  IF length(v_note) > 500 THEN
    RAISE EXCEPTION 'The description can be at most 500 characters' USING ERRCODE='22023'; END IF;

  v_coord := public.is_active_food_coordinator(v_uid);

  IF p_order_id IS NOT NULL THEN
    SELECT employee_id INTO v_owner FROM public.food_orders WHERE id = p_order_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  END IF;

  IF NOT v_coord THEN
    IF p_order_id IS NULL THEN
      RAISE EXCEPTION 'Choose the order the problem is about' USING ERRCODE='22023'; END IF;
    IF v_owner <> v_uid THEN
      RAISE EXCEPTION 'You can only report a problem with your own order' USING ERRCODE='42501'; END IF;
  END IF;

  BEGIN
    INSERT INTO public.food_exceptions (order_id, kind, detail, raised_by, raised_via)
    VALUES (p_order_id, p_kind, jsonb_build_object('note', v_note), v_uid,
            CASE WHEN v_coord THEN 'coordinator' ELSE 'employee' END)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You already have an open report on this order' USING ERRCODE='22023';
  END;

  PERFORM public.food_audit_write('exception', v_row.id, 'raised', NULL, to_jsonb(v_row),
    v_note, v_uid);

  -- An employee's report also appears on their own order's timeline.
  IF NOT v_coord THEN
    INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
    VALUES (p_order_id, 'problem_reported', NULL, NULL, p_kind, v_uid);
  END IF;

  RETURN jsonb_build_object('exception_id', v_row.id, 'kind', v_row.kind,
                            'order_id', v_row.order_id, 'raised_via', v_row.raised_via);
END $$;

-- ═══════════════ FM-13: pin pg_temp last on the remaining definer functions ═══════════════
ALTER FUNCTION public.food_require_active_coordinator()                                   SET search_path = public, pg_temp;
ALTER FUNCTION public.food_audit_write(text,uuid,text,jsonb,jsonb,text,uuid)               SET search_path = public, pg_temp;
ALTER FUNCTION public.food_upsert_meal(uuid,text,text,uuid,numeric,text,text)              SET search_path = public, pg_temp;
ALTER FUNCTION public.food_set_meal_status(uuid,text,text)                                 SET search_path = public, pg_temp;
ALTER FUNCTION public.food_schedule_meal(date,uuid,uuid,numeric,int,boolean)               SET search_path = public, pg_temp;
ALTER FUNCTION public.food_set_sold_out(uuid,boolean,text)                                 SET search_path = public, pg_temp;
ALTER FUNCTION public.food_cancel_my_order(uuid,text)                                      SET search_path = public, pg_temp;
ALTER FUNCTION public.food_transfer_coordinator(uuid,text,text)                            SET search_path = public, pg_temp;
ALTER FUNCTION public.food_upsert_category(uuid,text,int,text)                             SET search_path = public, pg_temp;
ALTER FUNCTION public.food_archive_category(uuid,text)                                     SET search_path = public, pg_temp;
ALTER FUNCTION public.food_upsert_service_period(uuid,text,time,time,text,int,boolean,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.food_coordinator_candidates()                                        SET search_path = public, pg_temp;
ALTER FUNCTION public.food_resolve_exception(uuid,text)                                    SET search_path = public, pg_temp;

-- ═══════════════ grants ═══════════════
-- Supabase default privileges grant EXECUTE on every new function to anon and
-- authenticated, so each NEW function is revoked from all three and granted
-- back to authenticated only. CREATE OR REPLACE keeps existing ACLs, so the
-- replaced functions retain the grants 20261009120001/130000 gave them; they
-- are restated here so this file is self-evidently least-privilege.
REVOKE ALL ON FUNCTION
  public.food_place_order(jsonb,text,text,text),
  public.food_people_names(uuid[]),
  public.food_can_use_canteen(),
  public.food_raise_exception(text,text,uuid),
  public.food_bootstrap_coordinator(uuid,text)
FROM PUBLIC, anon, authenticated;

-- Server-side only: appointing the first coordinator is never an API action.
GRANT EXECUTE ON FUNCTION public.food_bootstrap_coordinator(uuid,text) TO service_role;

REVOKE ALL ON FUNCTION
  public.is_food_coordinator(uuid), public.is_active_food_coordinator(uuid),
  public.food_menu_for_day(date), public.food_set_fulfilment(uuid,text,text),
  public.food_pay_order(uuid), public.food_coordinator_overview(date),
  public.food_preparation_list(date,uuid), public.food_set_closure(date,boolean,text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.food_place_order(jsonb,text,text,text),
  public.food_people_names(uuid[]),
  public.food_can_use_canteen(),
  public.food_raise_exception(text,text,uuid),
  public.is_food_coordinator(uuid), public.is_active_food_coordinator(uuid),
  public.food_menu_for_day(date), public.food_set_fulfilment(uuid,text,text),
  public.food_pay_order(uuid), public.food_coordinator_overview(date),
  public.food_preparation_list(date,uuid), public.food_set_closure(date,boolean,text)
TO authenticated;
