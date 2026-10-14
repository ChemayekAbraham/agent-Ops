DO $fm1guard_outer$
DECLARE
  s text := $fm1guard$-- Employee Food Ordering — operational RPCs: menu management, availability,
-- ordering, fulfilment, reporting and the coordinator handover.
--
-- NOT YET APPLIED. No wallet deduction, no ledger posting, no deployment.
--
-- PAYMENT IS DELIBERATELY DISABLED. `food_place_order` creates an UNPAID order:
-- it reads no wallet, debits nothing and writes no ledger entry. The only step
-- that would move money is `food_pay_order`, which raises FOOD_CHECKOUT_DISABLED
-- and stays shut until two things are approved: (a) the accounting treatment for
-- a meal payment, and (b) a ledger category (ledger_account_map row +
-- ledger_category_allowlist entry). Neither is invented here, and strict_mode is
-- ON, so no food category could post regardless.

-- ══════════════════════════ helpers ══════════════════════════

CREATE OR REPLACE FUNCTION public.food_require_active_coordinator()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid := auth.uid();
BEGIN
  IF v IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF NOT public.is_active_food_coordinator(v) THEN
    RAISE EXCEPTION 'Only the active Food Coordinator may do this' USING ERRCODE='42501';
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.food_audit_write(
  p_entity text, p_entity_id uuid, p_action text,
  p_before jsonb, p_after jsonb, p_reason text, p_actor uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.food_audit (entity, entity_id, action, before_val, after_val, reason, actor_id)
  VALUES (p_entity, p_entity_id, p_action, p_before, p_after, p_reason, p_actor);
$$;

-- ══════════════════════ menu management ══════════════════════

CREATE OR REPLACE FUNCTION public.food_upsert_meal(
  p_meal_id uuid, p_name text, p_description text, p_category_id uuid,
  p_price_ugx numeric, p_image_path text DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator();
        v_before jsonb; v_id uuid;
BEGIN
  IF p_name IS NULL OR length(btrim(p_name))=0 THEN
    RAISE EXCEPTION 'Meal name is required' USING ERRCODE='22023'; END IF;
  IF p_price_ugx IS NULL OR p_price_ugx < 0 THEN
    RAISE EXCEPTION 'Price must be zero or more' USING ERRCODE='22023'; END IF;

  IF p_meal_id IS NULL THEN
    INSERT INTO public.food_meals (name, description, category_id, price_ugx, image_path, created_by)
    VALUES (btrim(p_name), p_description, p_category_id, round(p_price_ugx,2), p_image_path, v_actor)
    RETURNING id INTO v_id;
    PERFORM public.food_audit_write('meal', v_id, 'created', NULL,
      jsonb_build_object('name',p_name,'price_ugx',p_price_ugx), p_reason, v_actor);
  ELSE
    SELECT to_jsonb(m) INTO v_before FROM public.food_meals m WHERE m.id=p_meal_id;
    IF v_before IS NULL THEN RAISE EXCEPTION 'Meal not found' USING ERRCODE='P0002'; END IF;
    IF (v_before->>'status')='archived' THEN
      RAISE EXCEPTION 'Archived meals cannot be edited' USING ERRCODE='22023'; END IF;
    UPDATE public.food_meals SET name=btrim(p_name), description=p_description,
           category_id=p_category_id, price_ugx=round(p_price_ugx,2),
           image_path=COALESCE(p_image_path,image_path), updated_at=now()
     WHERE id=p_meal_id RETURNING id INTO v_id;
    PERFORM public.food_audit_write('meal', v_id, 'updated', v_before,
      (SELECT to_jsonb(m) FROM public.food_meals m WHERE m.id=v_id), p_reason, v_actor);
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.food_set_meal_status(
  p_meal_id uuid, p_status text, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator(); v_before jsonb;
BEGIN
  IF p_status NOT IN ('draft','published','archived') THEN
    RAISE EXCEPTION 'Unknown meal status %', p_status USING ERRCODE='22023'; END IF;
  SELECT to_jsonb(m) INTO v_before FROM public.food_meals m WHERE m.id=p_meal_id;
  IF v_before IS NULL THEN RAISE EXCEPTION 'Meal not found' USING ERRCODE='P0002'; END IF;

  -- Archiving never deletes: historical orders keep their snapshot.
  UPDATE public.food_meals
     SET status=p_status,
         archived_at = CASE WHEN p_status='archived' THEN now() ELSE NULL END,
         updated_at=now()
   WHERE id=p_meal_id;
  PERFORM public.food_audit_write('meal', p_meal_id, 'status_'||p_status, v_before,
    (SELECT to_jsonb(m) FROM public.food_meals m WHERE m.id=p_meal_id), p_reason, v_actor);
END $$;

-- Put a meal on the menu for a date + period, with an optional serving limit.
CREATE OR REPLACE FUNCTION public.food_schedule_meal(
  p_service_date date, p_period_id uuid, p_meal_id uuid,
  p_price_ugx numeric DEFAULT NULL, p_servings_total int DEFAULT NULL,
  p_publish boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator();
        v_price numeric; v_id uuid;
BEGIN
  IF p_service_date < (now() AT TIME ZONE 'Africa/Kampala')::date THEN
    RAISE EXCEPTION 'Cannot schedule a meal in the past' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.food_service_closures WHERE closure_date=p_service_date) THEN
    RAISE EXCEPTION 'Service is closed on %', p_service_date USING ERRCODE='22023'; END IF;
  IF p_servings_total IS NOT NULL AND p_servings_total < 0 THEN
    RAISE EXCEPTION 'Servings cannot be negative' USING ERRCODE='22023'; END IF;

  -- never strand an order that is already reserved against this item
  IF p_servings_total IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.food_menu_items mi
        WHERE mi.service_date=p_service_date AND mi.period_id=p_period_id
          AND mi.meal_id=p_meal_id AND mi.servings_reserved > p_servings_total) THEN
    RAISE EXCEPTION 'Cannot set the serving cap below the quantity already ordered'
      USING ERRCODE='22023'; END IF;

  SELECT COALESCE(p_price_ugx, m.price_ugx) INTO v_price
    FROM public.food_meals m WHERE m.id=p_meal_id AND m.status='published';
  IF v_price IS NULL THEN
    RAISE EXCEPTION 'Meal not found or not published' USING ERRCODE='P0002'; END IF;

  INSERT INTO public.food_menu_items
    (service_date, period_id, meal_id, price_ugx, servings_total, published_at, created_by)
  VALUES (p_service_date, p_period_id, p_meal_id, round(v_price,2), p_servings_total,
          CASE WHEN p_publish THEN now() END, v_actor)
  ON CONFLICT (service_date, period_id, meal_id) DO UPDATE
    SET price_ugx      = EXCLUDED.price_ugx,
        servings_total = EXCLUDED.servings_total,
        published_at   = CASE WHEN p_publish THEN COALESCE(food_menu_items.published_at, now())
                              ELSE NULL END
  RETURNING id INTO v_id;

  PERFORM public.food_audit_write('menu_item', v_id,
    CASE WHEN p_publish THEN 'scheduled_published' ELSE 'scheduled_draft' END, NULL,
    jsonb_build_object('service_date',p_service_date,'price_ugx',v_price,
                       'servings_total',p_servings_total), NULL, v_actor);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.food_set_sold_out(
  p_menu_item_id uuid, p_sold_out boolean, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator();
BEGIN
  UPDATE public.food_menu_items SET sold_out=p_sold_out WHERE id=p_menu_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Menu item not found' USING ERRCODE='P0002'; END IF;
  PERFORM public.food_audit_write('menu_item', p_menu_item_id,
    CASE WHEN p_sold_out THEN 'sold_out' ELSE 'available' END, NULL, NULL, p_reason, v_actor);
END $$;

-- ═══════════════ employee-facing menu read ═══════════════

CREATE OR REPLACE FUNCTION public.food_menu_for_day(p_service_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
        v_day date := COALESCE(p_service_date, (now() AT TIME ZONE 'Africa/Kampala')::date);
        v_now time := (now() AT TIME ZONE 'Africa/Kampala')::time;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;

  RETURN jsonb_build_object(
    'service_date', v_day,
    'closed', EXISTS (SELECT 1 FROM public.food_service_closures WHERE closure_date=v_day),
    'checkout_enabled', false,   -- wallet checkout is disabled pending approval
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
        ), '[]'::jsonb))
        ORDER BY sp.ordering_opens_at)
      FROM public.food_service_periods sp WHERE sp.active
    ), '[]'::jsonb));
END $$;

-- ═══════════════ ordering (CHECKOUT DISABLED) ═══════════════

CREATE OR REPLACE FUNCTION public.food_place_order(
  p_items jsonb, p_idempotency_key text, p_special_instructions text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_now time := (now() AT TIME ZONE 'Africa/Kampala')::time;
  v_id uuid; v_ref text; v_date date; v_period uuid; v_total numeric(14,2) := 0;
  v_existing public.food_orders%ROWTYPE;
  v_max int; v_already int; v_asked int; it jsonb; v_mi record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key))=0 THEN
    RAISE EXCEPTION 'An idempotency key is required' USING ERRCODE='22023'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items)=0 THEN
    RAISE EXCEPTION 'Your order is empty' USING ERRCODE='22023'; END IF;

  -- Replaying the same key returns the original order rather than a second one.
  SELECT * INTO v_existing FROM public.food_orders WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.employee_id <> v_uid THEN
      RAISE EXCEPTION 'That order reference is already in use' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('order_id', v_existing.id, 'order_reference', v_existing.order_reference,
      'total_ugx', v_existing.total_ugx, 'payment_status', v_existing.payment_status, 'replayed', true);
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _food_basket(
    menu_item_id uuid PRIMARY KEY, quantity int, meal_id uuid, meal_name text,
    meal_description text, unit_price numeric(14,2)) ON COMMIT DROP;
  DELETE FROM _food_basket;

  -- collapse duplicate lines for the same meal as they arrive
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (it->>'quantity') IS NULL OR (it->>'quantity')::int <= 0 THEN
      RAISE EXCEPTION 'Every line needs a quantity of at least 1' USING ERRCODE='22023'; END IF;
    INSERT INTO _food_basket(menu_item_id, quantity)
    VALUES ((it->>'menu_item_id')::uuid, (it->>'quantity')::int)
    ON CONFLICT (menu_item_id) DO UPDATE
      SET quantity = _food_basket.quantity + EXCLUDED.quantity;
  END LOOP;

  -- Validate, and lock each menu row in a stable order (id) so two employees
  -- racing for the last servings cannot deadlock against each other.
  -- An unknown menu item is caught first: a row lock cannot be taken on the
  -- nullable side of an outer join, so the locking read below must be an
  -- INNER join and every basket line has to be known to exist by then.
  IF EXISTS (SELECT 1 FROM _food_basket b
              LEFT JOIN public.food_menu_items mi ON mi.id = b.menu_item_id
             WHERE mi.id IS NULL) THEN
    RAISE EXCEPTION 'One of the meals is no longer on the menu' USING ERRCODE='P0002'; END IF;

  FOR v_mi IN
    SELECT b.menu_item_id, b.quantity, mi.service_date, mi.period_id, mi.meal_id,
           mi.price_ugx, mi.sold_out, mi.published_at,
           m.name, m.description, m.status
      FROM _food_basket b
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

    UPDATE _food_basket SET meal_id=v_mi.meal_id, meal_name=v_mi.name,
           meal_description=v_mi.description, unit_price=v_mi.price_ugx
     WHERE menu_item_id = v_mi.menu_item_id;
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

  -- per-employee cap across everything they already hold for this period
  IF v_max IS NOT NULL THEN
    -- Serialise this employee's submissions for this service period.
    --
    -- WHY: the count below is the only thing standing between one person and
    -- more than their allowance. Two carts that share no meal take no common
    -- row lock, so without this both could read the same count before either
    -- inserts, and jointly exceed the cap. The menu-row locks above do not
    -- help: they only overlap when the carts do.
    --
    -- SCOPE: exactly (employee, service period). Two different employees never
    -- contend, and the same employee ordering for a different period does not
    -- either. Nothing is globally serialised.
    --
    -- LOCK ORDER — applied consistently by every caller of this function:
    --   1. food_menu_items rows, ascending by id (the FOR NO KEY UPDATE loop)
    --   2. this advisory lock
    -- No code path takes them the other way round, so no cycle can form.
    --
    -- KEY: a (namespace, identity) pair of int4s.
    --   namespace = hashtext('food_place_order_cap') keeps this from colliding
    --               with any other advisory lock in the database;
    --   identity  = hashtext(employee || ':' || period).
    -- A hashtext collision would make two unrelated (employee, period) pairs
    -- queue behind each other — a little needless waiting, never a breached
    -- cap. The lock is held to the end of the transaction, so it is released
    -- by COMMIT or ROLLBACK without any explicit unlock.
    PERFORM pg_advisory_xact_lock(
      hashtext('food_place_order_cap'),
      hashtext(v_uid::text || ':' || v_period::text));

    SELECT COALESCE(SUM(oi.quantity),0) INTO v_already
      FROM public.food_orders o JOIN public.food_order_items oi ON oi.order_id = o.id
     WHERE o.employee_id = v_uid AND o.service_date = v_date AND o.period_id = v_period
       AND o.fulfilment_status <> 'cancelled';
    SELECT COALESCE(SUM(quantity),0) INTO v_asked FROM _food_basket;
    IF v_already + v_asked > v_max THEN
      RAISE EXCEPTION 'You can order at most % item(s) for this service period, and you already have %',
        v_max, v_already USING ERRCODE='22023'; END IF;
  END IF;

  v_id  := gen_random_uuid();
  v_ref := 'FO-' || to_char(now() AT TIME ZONE 'Africa/Kampala','YYMMDD') || '-' ||
           upper(substr(replace(v_id::text,'-',''),1,6));

  -- NO PAYMENT HAPPENS HERE. The order is created unpaid: no wallet is read or
  -- debited and no ledger entry is written. Settlement is food_pay_order, which
  -- is still disabled pending an approved accounting treatment.
  -- CONCURRENT REPLAY. The replay read near the top of this function takes no
  -- lock, so two simultaneous submissions of the same key both miss it and both
  -- arrive here. idempotency_key is NOT NULL UNIQUE, so exactly one INSERT wins
  -- and the loser raises 23505. Without this handler the loser received a raw
  -- unique-violation instead of the replay response the key exists to provide.
  --
  -- SCOPE: the handler wraps ONLY this INSERT. A check_violation from the
  -- servings UPDATE further down, or any other error, is untouched and still
  -- propagates. unique_violation is the only condition caught, and even then the
  -- re-read decides the outcome - nothing is assumed from the error alone.
  --
  -- ISOLATION. At READ COMMITTED the loser blocks on the unique index until the
  -- winner commits; each statement then takes a fresh snapshot, so the re-read
  -- below sees the winning row. At REPEATABLE READ or SERIALIZABLE the loser's
  -- snapshot predates that commit and the re-read finds NOTHING. That case is
  -- NOT treated as a replay: it raises 40001 so the caller retries, rather than
  -- inventing a response. This has not been verified by execution.
  BEGIN
    INSERT INTO public.food_orders (id, order_reference, employee_id, service_date, period_id,
           total_ugx, payment_status, fulfilment_status, idempotency_key, special_instructions)
    VALUES (v_id, v_ref, v_uid, v_date, v_period, v_total, 'pending_payment', 'confirmed',
            p_idempotency_key, p_special_instructions);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM public.food_orders
     WHERE idempotency_key = p_idempotency_key;

    IF NOT FOUND THEN
      -- Either the winner is invisible under this isolation level, or the
      -- collision was on order_reference rather than the key. Neither is a
      -- replay; both are safely retryable.
      RAISE EXCEPTION 'Your order could not be confirmed because another request was in flight. Please try again.'
        USING ERRCODE = '40001',
              HINT = 'No order was created by this request.';
    END IF;

    -- Ownership is re-checked here, exactly as on the replay path above: a key
    -- that belongs to someone else must never return their order.
    IF v_existing.employee_id <> v_uid THEN
      RAISE EXCEPTION 'That order reference is already in use' USING ERRCODE='22023';
    END IF;

    RETURN jsonb_build_object('order_id', v_existing.id, 'order_reference', v_existing.order_reference,
      'total_ugx', v_existing.total_ugx, 'payment_status', v_existing.payment_status, 'replayed', true);
  END;

  INSERT INTO public.food_order_items (order_id, menu_item_id, meal_id, meal_name,
         meal_description, unit_price_ugx, quantity, line_total_ugx)
  SELECT v_id, b.menu_item_id, b.meal_id, b.meal_name, b.meal_description,
         b.unit_price, b.quantity, round(b.unit_price * b.quantity, 2)
    FROM _food_basket b;

  -- Reserve the servings. The within-stock CHECK is what actually prevents an
  -- oversell; the row locks above make the read-then-write safe under contention.
  BEGIN
    UPDATE public.food_menu_items mi
       SET servings_reserved = mi.servings_reserved + b.quantity
      FROM _food_basket b
     WHERE mi.id = b.menu_item_id;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'Not enough servings left for that quantity' USING ERRCODE='22023';
  END;

  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (v_id, 'placed', NULL, 'confirmed', 'Unpaid order placed', v_uid);

  RETURN jsonb_build_object('order_id', v_id, 'order_reference', v_ref,
    'total_ugx', v_total, 'payment_status', 'pending_payment', 'replayed', false);
END $$;

-- Settlement. STILL DISABLED: this is the only step that would move money, and
-- it stays shut until a meal-payment accounting treatment and an allowlisted
-- ledger category are approved. strict_mode is ON, so a wallet leg could not
-- post even if this body were written.
CREATE OR REPLACE FUNCTION public.food_pay_order(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'FOOD_CHECKOUT_DISABLED: paying for a meal is not enabled yet. Pending approval of the meal-payment accounting treatment and a ledger category.'
    USING ERRCODE='0A000',
          HINT='The order is unaffected and no wallet was read or debited.';
END $$;

-- An employee may withdraw their own unpaid order while the kitchen has not
-- started it. Releases the reserved servings exactly once, via stock_released.
CREATE OR REPLACE FUNCTION public.food_cancel_my_order(
  p_order_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_o public.food_orders%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT * INTO v_o FROM public.food_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF v_o.employee_id <> v_uid THEN
    RAISE EXCEPTION 'That is not your order' USING ERRCODE='42501'; END IF;
  IF v_o.fulfilment_status <> 'confirmed' THEN
    RAISE EXCEPTION 'The kitchen has already started this order' USING ERRCODE='22023'; END IF;
  IF v_o.payment_status = 'paid' THEN
    -- a paid order is a refund decision, not a self-service cancellation
    RAISE EXCEPTION 'Paid orders are cancelled by the Food Coordinator' USING ERRCODE='22023'; END IF;

  UPDATE public.food_orders
     SET fulfilment_status='cancelled', cancelled_at=now(), stock_released=true
   WHERE id = p_order_id;

  IF NOT v_o.stock_released THEN
    UPDATE public.food_menu_items mi
       SET servings_reserved = GREATEST(mi.servings_reserved - oi.quantity, 0)
      FROM public.food_order_items oi
     WHERE oi.order_id = p_order_id AND mi.id = oi.menu_item_id;
  END IF;

  INSERT INTO public.food_order_events (order_id, event_type, from_status, to_status, note, actor_id)
  VALUES (p_order_id, 'cancelled', v_o.fulfilment_status, 'cancelled',
          COALESCE(p_reason,'Withdrawn by the employee'), v_uid);

  RETURN jsonb_build_object('order_id', p_order_id, 'status', 'cancelled');
END $$;

-- ═══════════════ fulfilment ═══════════════

CREATE OR REPLACE FUNCTION public.food_set_fulfilment(
  p_order_id uuid, p_to_status text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator();
        v_from text; v_pay text; v_ok boolean; v_released boolean;
BEGIN
  -- FOR UPDATE is what makes the cancel path safe under contention: two
  -- simultaneous cancellations both queue here, and the second one then reads
  -- fulfilment_status='cancelled' and is refused by the terminal-state guard
  -- below. The reservation can therefore only ever be released once.
  SELECT fulfilment_status, payment_status, stock_released
    INTO v_from, v_pay, v_released
    FROM public.food_orders WHERE id=p_order_id FOR UPDATE;
  IF v_from IS NULL THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;

  -- terminal states are never silently overwritten
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

  -- preparation requires confirmed payment
  IF p_to_status='preparing' AND v_pay <> 'paid' THEN
    RAISE EXCEPTION 'Unpaid orders cannot enter preparation' USING ERRCODE='22023'; END IF;

  -- Cancellation releases the reservation. Without this a coordinator-cancelled
  -- order held its servings for the rest of the service day and the meal read as
  -- sold out early; food_cancel_my_order already did this and this path did not.
  -- The status change and the release are one statement pair inside the caller's
  -- transaction, under the row lock taken above, so they commit or abort together.
  IF p_to_status = 'cancelled' THEN
    UPDATE public.food_orders
       SET fulfilment_status = p_to_status,
           cancelled_at      = now(),
           stock_released    = true
     WHERE id = p_order_id;

    -- stock_released is the exactly-once guard, read before the UPDATE above.
    -- GREATEST(...,0) mirrors food_cancel_my_order and keeps servings_reserved
    -- within its CHECK (servings_reserved >= 0) even on an unexpected state.
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

-- ═══════════════ coordinator reporting ═══════════════

CREATE OR REPLACE FUNCTION public.food_coordinator_overview(p_service_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_day date := COALESCE(p_service_date, (now() AT TIME ZONE 'Africa/Kampala')::date);
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_food_coordinator(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised to view Food Management' USING ERRCODE='42501'; END IF;

  RETURN jsonb_build_object(
    'service_date', v_day,
    'checkout_enabled', false,
    -- The kitchen must see payment before preparing. food_set_fulfilment
    -- enforces this; the flag is reported so the UI reads the rule instead of
    -- inferring it. The isolated development fixture reports false so the
    -- operational workflow can be exercised while payment is impossible.
    -- Changing this to false in production is a separate, explicit decision.
    'fulfilment_requires_payment', true,
    'menu_published', (SELECT count(*) FROM public.food_menu_items
                        WHERE service_date=v_day AND published_at IS NOT NULL),
    'orders_today',   (SELECT count(*) FROM public.food_orders WHERE service_date=v_day),
    -- a count of orders awaiting payment, not a money figure
    'unpaid_orders',  (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND payment_status='pending_payment'),
    'awaiting_prep',  (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND payment_status='paid' AND fulfilment_status='confirmed'),
    'preparing',      (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND fulfilment_status='preparing'),
    'ready',          (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND fulfilment_status='ready'),
    'completed',      (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND fulfilment_status IN ('collected','delivered')),
    'cancelled',      (SELECT count(*) FROM public.food_orders
                        WHERE service_date=v_day AND fulfilment_status='cancelled'),
    'open_exceptions',(SELECT count(*) FROM public.food_exceptions WHERE resolved_at IS NULL),
    -- an order total, NOT accounting revenue; no accounting treatment is approved
    'paid_order_total_ugx', (SELECT COALESCE(SUM(total_ugx),0) FROM public.food_orders
                              WHERE service_date=v_day AND payment_status='paid'));
END $$;

-- Consolidated kitchen preparation list: paid, non-cancelled orders only.
CREATE OR REPLACE FUNCTION public.food_preparation_list(
  p_service_date date DEFAULT NULL, p_period_id uuid DEFAULT NULL)
RETURNS TABLE (meal_name text, total_quantity bigint, order_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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
       AND o.payment_status='paid'
       AND o.fulfilment_status NOT IN ('cancelled')
     GROUP BY oi.meal_name ORDER BY 2 DESC;
END $$;

-- ═══════════════ coordinator handover ═══════════════
-- Transferable by design, fully audited. No incoming coordinator is configured.

CREATE OR REPLACE FUNCTION public.food_transfer_coordinator(
  p_to_user_id uuid, p_mode text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator(); v_name text;
BEGIN
  IF p_mode NOT IN ('full_transfer','transfer_with_backup') THEN
    RAISE EXCEPTION 'Handover mode must be full_transfer or transfer_with_backup' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required' USING ERRCODE='22023'; END IF;
  IF p_to_user_id = v_actor THEN
    RAISE EXCEPTION 'Cannot hand over to yourself' USING ERRCODE='22023'; END IF;

  -- ELIGIBILITY IS DECIDED HERE, SERVER-SIDE. food_coordinator_candidates()
  -- applies these same three predicates, but it only feeds the picker: a
  -- coordinator calling this RPC directly could previously hand the role to a
  -- tenant, a landlord, a disabled account or a soft-deleted one, because the
  -- only check was that a profiles row existed. The UI filter is not an
  -- enforcement point; this is.
  --
  -- The predicates mirror M3 exactly - role 'employee', enabled, not deleted -
  -- so the picker and the RPC can never disagree about who is eligible.
  SELECT p.full_name INTO v_name
    FROM public.profiles p
   WHERE p.id = p_to_user_id
     AND p.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = p.id
                    AND ur.role = 'employee'::public.app_role
                    AND COALESCE(ur.enabled, true));
  IF v_name IS NULL THEN
    -- Deliberately one message for every ineligible case. Distinguishing
    -- "no such profile" from "not an employee" would let a coordinator probe
    -- the staff directory through this RPC.
    RAISE EXCEPTION 'Incoming coordinator is not an eligible employee account'
      USING ERRCODE='P0002',
            HINT='The recipient must be an enabled employee with an active profile.';
  END IF;

  -- retire the outgoing assignment first so the one-active index is satisfied
  UPDATE public.food_coordinator_assignments
     SET revoked_at=now(), revoked_by=v_actor, handover_mode=p_mode, reason=p_reason
   WHERE coordinator_id=v_actor AND revoked_at IS NULL;

  -- and retire any prior (e.g. backup) assignment the incoming holder still has,
  -- so a handover can never leave one person with two live rows
  UPDATE public.food_coordinator_assignments
     SET revoked_at=now(), revoked_by=v_actor, reason='Superseded by handover'
   WHERE coordinator_id=p_to_user_id AND revoked_at IS NULL;

  INSERT INTO public.food_coordinator_assignments
    (coordinator_id, access_level, assigned_by, handover_mode, reason)
  VALUES (p_to_user_id, 'active', v_actor, p_mode, p_reason);

  IF p_mode='transfer_with_backup' THEN
    INSERT INTO public.food_coordinator_assignments
      (coordinator_id, access_level, assigned_by, handover_mode, reason)
    VALUES (v_actor, 'backup', v_actor, p_mode, 'Retained read-only backup access');
  END IF;

  PERFORM public.food_audit_write('coordinator', p_to_user_id, 'handover_'||p_mode,
    jsonb_build_object('from', v_actor), jsonb_build_object('to', p_to_user_id, 'mode', p_mode),
    p_reason, v_actor);

  RETURN jsonb_build_object('status','transferred','from',v_actor,'to',p_to_user_id,
                            'to_name',v_name,'mode',p_mode);
END $$;

-- ═══════ categories, service periods and closures ═══════
-- The REVOKE below removes every direct write privilege, so these are the only
-- way to maintain the supporting records. Without them the coordinator could
-- create meals but have nowhere to put them.

CREATE OR REPLACE FUNCTION public.food_upsert_category(
  p_category_id uuid, p_name text, p_sort_order int DEFAULT 100, p_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator();
        v_before jsonb; v_id uuid;
BEGIN
  IF p_name IS NULL OR length(btrim(p_name))=0 THEN
    RAISE EXCEPTION 'Category name is required' USING ERRCODE='22023'; END IF;

  IF p_category_id IS NULL THEN
    INSERT INTO public.food_categories (name, sort_order, created_by)
    VALUES (btrim(p_name), COALESCE(p_sort_order,100), v_actor) RETURNING id INTO v_id;
    PERFORM public.food_audit_write('category', v_id, 'created', NULL,
      jsonb_build_object('name',p_name), p_reason, v_actor);
  ELSE
    SELECT to_jsonb(c) INTO v_before FROM public.food_categories c WHERE c.id=p_category_id;
    IF v_before IS NULL THEN RAISE EXCEPTION 'Category not found' USING ERRCODE='P0002'; END IF;
    UPDATE public.food_categories SET name=btrim(p_name), sort_order=COALESCE(p_sort_order,sort_order)
     WHERE id=p_category_id RETURNING id INTO v_id;
    PERFORM public.food_audit_write('category', v_id, 'updated', v_before,
      (SELECT to_jsonb(c) FROM public.food_categories c WHERE c.id=v_id), p_reason, v_actor);
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.food_archive_category(
  p_category_id uuid, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator(); v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.food_meals
   WHERE category_id=p_category_id AND status <> 'archived';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Move or archive the % meal(s) in this category first', v_n
      USING ERRCODE='22023'; END IF;
  UPDATE public.food_categories SET archived_at=now() WHERE id=p_category_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Category not found' USING ERRCODE='P0002'; END IF;
  PERFORM public.food_audit_write('category', p_category_id, 'archived', NULL, NULL, p_reason, v_actor);
END $$;

CREATE OR REPLACE FUNCTION public.food_upsert_service_period(
  p_period_id uuid, p_name text, p_opens_at time, p_closes_at time,
  p_collection_instructions text DEFAULT NULL, p_max_qty_per_employee int DEFAULT NULL,
  p_active boolean DEFAULT true, p_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator();
        v_before jsonb; v_id uuid;
BEGIN
  IF p_name IS NULL OR length(btrim(p_name))=0 THEN
    RAISE EXCEPTION 'Period name is required' USING ERRCODE='22023'; END IF;
  IF p_opens_at IS NULL OR p_closes_at IS NULL OR p_closes_at <= p_opens_at THEN
    RAISE EXCEPTION 'Ordering must close after it opens' USING ERRCODE='22023'; END IF;
  IF p_max_qty_per_employee IS NOT NULL AND p_max_qty_per_employee <= 0 THEN
    RAISE EXCEPTION 'The per-employee limit must be at least 1' USING ERRCODE='22023'; END IF;

  IF p_period_id IS NULL THEN
    INSERT INTO public.food_service_periods
      (name, ordering_opens_at, ordering_closes_at, collection_instructions,
       max_qty_per_employee, active)
    VALUES (btrim(p_name), p_opens_at, p_closes_at, p_collection_instructions,
            p_max_qty_per_employee, COALESCE(p_active,true))
    RETURNING id INTO v_id;
    PERFORM public.food_audit_write('period', v_id, 'created', NULL,
      jsonb_build_object('name',p_name,'opens',p_opens_at,'closes',p_closes_at), p_reason, v_actor);
  ELSE
    SELECT to_jsonb(sp) INTO v_before FROM public.food_service_periods sp WHERE sp.id=p_period_id;
    IF v_before IS NULL THEN RAISE EXCEPTION 'Service period not found' USING ERRCODE='P0002'; END IF;
    UPDATE public.food_service_periods
       SET name=btrim(p_name), ordering_opens_at=p_opens_at, ordering_closes_at=p_closes_at,
           collection_instructions=p_collection_instructions,
           max_qty_per_employee=p_max_qty_per_employee, active=COALESCE(p_active,active)
     WHERE id=p_period_id RETURNING id INTO v_id;
    PERFORM public.food_audit_write('period', v_id, 'updated', v_before,
      (SELECT to_jsonb(sp) FROM public.food_service_periods sp WHERE sp.id=v_id), p_reason, v_actor);
  END IF;
  RETURN v_id;
END $$;

-- Open or close a service date. Closing a day that already has live paid orders
-- is refused: those employees have paid and are expecting food.
CREATE OR REPLACE FUNCTION public.food_set_closure(
  p_closure_date date, p_closed boolean, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator(); v_n int;
BEGIN
  IF p_closed THEN
    IF p_reason IS NULL OR length(btrim(p_reason))=0 THEN
      RAISE EXCEPTION 'A reason is required to close a service day' USING ERRCODE='22023'; END IF;
    SELECT count(*) INTO v_n FROM public.food_orders
     WHERE service_date=p_closure_date AND payment_status='paid'
       AND fulfilment_status NOT IN ('cancelled','collected','delivered');
    IF v_n > 0 THEN
      RAISE EXCEPTION 'Cannot close %: % paid order(s) are still outstanding', p_closure_date, v_n
        USING ERRCODE='22023'; END IF;

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

-- ═══════════════ grants ═══════════════
-- Default privileges in this database grant EXECUTE on every new function in
-- `public` to anon AND authenticated, so revoking from PUBLIC+anon alone is NOT
-- enough. Verified in the sandbox on 2026-10-09: an ordinary employee could call
-- food_audit_write directly and forge an audit row. Revoke from all three first,
-- then grant back only the RPCs the UI is meant to call; the two internal helpers
-- are deliberately left with no authenticated EXECUTE.
REVOKE EXECUTE ON FUNCTION
  public.food_require_active_coordinator(),
  public.food_audit_write(text,uuid,text,jsonb,jsonb,text,uuid),
  public.food_upsert_category(uuid,text,int,text),
  public.food_archive_category(uuid,text),
  public.food_upsert_service_period(uuid,text,time,time,text,int,boolean,text),
  public.food_set_closure(date,boolean,text),
  public.food_upsert_meal(uuid,text,text,uuid,numeric,text,text),
  public.food_set_meal_status(uuid,text,text),
  public.food_schedule_meal(date,uuid,uuid,numeric,int,boolean),
  public.food_set_sold_out(uuid,boolean,text),
  public.food_menu_for_day(date),
  public.food_place_order(jsonb,text,text),
  public.food_pay_order(uuid),
  public.food_cancel_my_order(uuid,text),
  public.food_set_fulfilment(uuid,text,text),
  public.food_coordinator_overview(date),
  public.food_preparation_list(date,uuid),
  public.food_transfer_coordinator(uuid,text,text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.food_upsert_category(uuid,text,int,text),
  public.food_archive_category(uuid,text),
  public.food_upsert_service_period(uuid,text,time,time,text,int,boolean,text),
  public.food_set_closure(date,boolean,text),
  public.food_upsert_meal(uuid,text,text,uuid,numeric,text,text),
  public.food_set_meal_status(uuid,text,text),
  public.food_schedule_meal(date,uuid,uuid,numeric,int,boolean),
  public.food_set_sold_out(uuid,boolean,text),
  public.food_menu_for_day(date),
  public.food_place_order(jsonb,text,text),
  public.food_pay_order(uuid),
  public.food_cancel_my_order(uuid,text),
  public.food_set_fulfilment(uuid,text,text),
  public.food_coordinator_overview(date),
  public.food_preparation_list(date,uuid),
  public.food_transfer_coordinator(uuid,text,text)
TO authenticated;

-- food_audit_write and food_require_active_coordinator stay service-side only.
$fm1guard$;
  h text := encode(sha256(convert_to(s, 'UTF8')), 'hex');
BEGIN
  IF h <> '016fa92f1a3dc0c6091b6027335024457b56bd6723c1f8013cd281d9b4a867ac' THEN
    RAISE EXCEPTION 'food m1 guard: 20261009130001 checksum mismatch, got %', h;
  END IF;
  EXECUTE s;
END
$fm1guard_outer$;