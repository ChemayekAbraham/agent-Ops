-- Employee Food Ordering — schema, access control and the transferable Food Coordinator.
--
-- NOT YET APPLIED. No live wallet deduction, no financial posting, no deployment.
--
-- DESIGN NOTES
-- ------------
-- 1. Coordinator is an ASSIGNMENT, not an app_role. `app_role` has 25 values and none
--    is food-related, and `employee` is far too broad to gate menu and price
--    control. A dedicated assignment table keeps app_role untouched, makes the role
--    transferable by design and gives the handover audit trail for free. No
--    successor is named or pre-configured anywhere in this feature; a handover
--    happens only when someone calls food_transfer_coordinator.
-- 2. Money NEVER moves here. Checkout posts through create_ledger_transaction in a
--    separate migration. This file creates no ledger legs and no wallet writes.
-- 3. Order lines SNAPSHOT name, description and unit price, so a later menu edit can
--    never restate a confirmed order (Part 24).
-- 4. Payment status and fulfilment status are separate columns with separate
--    transitions (Part 4).

-- ─────────────────────────────── categories ───────────────────────────────
CREATE TABLE public.food_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
  sort_order  int  NOT NULL DEFAULT 100,
  archived_at timestamptz,
  created_by  uuid NOT NULL REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────────── meals ──────────────────────────────────
CREATE TABLE public.food_meals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  description  text,
  image_path   text,
  category_id  uuid REFERENCES public.food_categories(id),
  price_ugx    numeric(14,2) NOT NULL CHECK (price_ugx >= 0),
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','published','archived')),
  archived_at  timestamptz,
  created_by   uuid NOT NULL REFERENCES public.profiles(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX food_meals_status_idx ON public.food_meals (status) WHERE archived_at IS NULL;

-- ───────────────────── service periods and ordering rules ─────────────────
CREATE TABLE public.food_service_periods (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL UNIQUE,         -- Breakfast, Lunch, …
  ordering_opens_at       time NOT NULL,
  ordering_closes_at      time NOT NULL,
  collection_instructions text,
  max_qty_per_employee    int CHECK (max_qty_per_employee IS NULL OR max_qty_per_employee > 0),
  active                  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (ordering_closes_at > ordering_opens_at)
);

CREATE TABLE public.food_service_closures (
  closure_date date PRIMARY KEY,
  reason       text NOT NULL,
  created_by   uuid NOT NULL REFERENCES public.profiles(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ───────────── the published menu: a meal, on a date, in a period ─────────
CREATE TABLE public.food_menu_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_date      date NOT NULL,
  period_id         uuid NOT NULL REFERENCES public.food_service_periods(id),
  meal_id           uuid NOT NULL REFERENCES public.food_meals(id),
  price_ugx         numeric(14,2) NOT NULL CHECK (price_ugx >= 0),  -- price on the day
  servings_total    int CHECK (servings_total IS NULL OR servings_total >= 0),
  servings_reserved int NOT NULL DEFAULT 0 CHECK (servings_reserved >= 0),
  sold_out          boolean NOT NULL DEFAULT false,
  published_at      timestamptz,
  created_by        uuid NOT NULL REFERENCES public.profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_date, period_id, meal_id),
  -- stock can never be oversold; enforced atomically at the row level
  CONSTRAINT food_menu_items_within_stock
    CHECK (servings_total IS NULL OR servings_reserved <= servings_total)
);
CREATE INDEX food_menu_items_day_idx ON public.food_menu_items (service_date, period_id);

-- ───────────────────────────────── orders ─────────────────────────────────
CREATE TABLE public.food_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_reference    text NOT NULL UNIQUE,
  employee_id        uuid NOT NULL REFERENCES public.profiles(id),
  service_date       date NOT NULL,
  period_id          uuid NOT NULL REFERENCES public.food_service_periods(id),
  total_ugx          numeric(14,2) NOT NULL CHECK (total_ugx >= 0),  -- server-computed
  payment_status     text NOT NULL DEFAULT 'pending_payment'
                       CHECK (payment_status IN ('pending_payment','paid','payment_failed',
                                                 'refund_pending','refunded')),
  fulfilment_status  text NOT NULL DEFAULT 'confirmed'
                       CHECK (fulfilment_status IN ('confirmed','preparing','ready','collected',
                                                    'delivered','cancelled')),
  transaction_group_id uuid,            -- authoritative wallet result
  idempotency_key    text NOT NULL UNIQUE,
  special_instructions text,
  placed_at          timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz,
  cancelled_at       timestamptz,
  stock_released     boolean NOT NULL DEFAULT false,  -- guards double restock
  CONSTRAINT food_orders_paid_needs_txn
    CHECK (payment_status <> 'paid' OR transaction_group_id IS NOT NULL)
);
CREATE INDEX food_orders_employee_idx ON public.food_orders (employee_id, placed_at DESC);
CREATE INDEX food_orders_queue_idx    ON public.food_orders (service_date, fulfilment_status)
  WHERE payment_status = 'paid';

CREATE TABLE public.food_order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES public.food_orders(id) ON DELETE CASCADE,
  menu_item_id   uuid NOT NULL REFERENCES public.food_menu_items(id),
  meal_id        uuid NOT NULL REFERENCES public.food_meals(id),
  -- snapshots: a later menu edit must never restate a confirmed order
  meal_name      text NOT NULL,
  meal_description text,
  unit_price_ugx numeric(14,2) NOT NULL CHECK (unit_price_ugx >= 0),
  quantity       int NOT NULL CHECK (quantity > 0),
  line_total_ugx numeric(14,2) NOT NULL CHECK (line_total_ugx >= 0),
  CONSTRAINT food_order_items_line_math
    CHECK (line_total_ugx = round(unit_price_ugx * quantity, 2))
);
CREATE INDEX food_order_items_order_idx ON public.food_order_items (order_id);

-- ──────────────────────── audit / events / exceptions ─────────────────────
CREATE TABLE public.food_order_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES public.food_orders(id),
  event_type  text NOT NULL,
  from_status text,
  to_status   text,
  note        text,
  actor_id    uuid NOT NULL REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX food_order_events_order_idx ON public.food_order_events (order_id, created_at);

CREATE TABLE public.food_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid REFERENCES public.food_orders(id),
  kind        text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.food_audit (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity     text NOT NULL,           -- meal | menu_item | period | order | coordinator
  entity_id  uuid,
  action     text NOT NULL,
  before_val jsonb,
  after_val  jsonb,
  reason     text,
  actor_id   uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX food_audit_entity_idx ON public.food_audit (entity, entity_id, created_at DESC);

-- ──────────────── the transferable Food Coordinator assignment ────────────
CREATE TABLE public.food_coordinator_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coordinator_id uuid NOT NULL REFERENCES public.profiles(id),
  access_level  text NOT NULL DEFAULT 'active'
                  CHECK (access_level IN ('active','backup')),
  assigned_by   uuid REFERENCES public.profiles(id),
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES public.profiles(id),
  handover_mode text CHECK (handover_mode IN ('full_transfer','transfer_with_backup')),
  reason        text
);
-- exactly one ACTIVE coordinator at a time
CREATE UNIQUE INDEX food_one_active_coordinator
  ON public.food_coordinator_assignments ((true))
  WHERE revoked_at IS NULL AND access_level = 'active';
CREATE INDEX food_coordinator_lookup
  ON public.food_coordinator_assignments (coordinator_id) WHERE revoked_at IS NULL;

-- Authoritative permission check. SECURITY DEFINER so RLS on the assignment
-- table cannot be used to spoof a positive result.
CREATE OR REPLACE FUNCTION public.is_food_coordinator(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.food_coordinator_assignments a
     WHERE a.coordinator_id = _user_id AND a.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.is_active_food_coordinator(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.food_coordinator_assignments a
     WHERE a.coordinator_id = _user_id AND a.revoked_at IS NULL
       AND a.access_level = 'active'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_food_coordinator(uuid)        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_active_food_coordinator(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_food_coordinator(uuid)        TO authenticated;
GRANT  EXECUTE ON FUNCTION public.is_active_food_coordinator(uuid) TO authenticated;

-- ───────────────────────── row level security ─────────────────────────────
ALTER TABLE public.food_categories              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_meals                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_service_periods         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_service_closures        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_menu_items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_orders                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_order_items             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_order_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_exceptions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_audit                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_coordinator_assignments ENABLE ROW LEVEL SECURITY;

-- Employees read the published menu only.
CREATE POLICY food_cat_read      ON public.food_categories      FOR SELECT TO authenticated USING (archived_at IS NULL);
CREATE POLICY food_periods_read  ON public.food_service_periods FOR SELECT TO authenticated USING (active);
CREATE POLICY food_closures_read ON public.food_service_closures FOR SELECT TO authenticated USING (true);
CREATE POLICY food_meals_read    ON public.food_meals FOR SELECT TO authenticated
  USING (status = 'published' OR public.is_food_coordinator(auth.uid()));
CREATE POLICY food_menu_read     ON public.food_menu_items FOR SELECT TO authenticated
  USING (published_at IS NOT NULL OR public.is_food_coordinator(auth.uid()));

-- Employees see ONLY their own orders. Coordinator sees all.
CREATE POLICY food_orders_read ON public.food_orders FOR SELECT TO authenticated
  USING (employee_id = auth.uid() OR public.is_food_coordinator(auth.uid()));
CREATE POLICY food_items_read  ON public.food_order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.food_orders o WHERE o.id = order_id
                   AND (o.employee_id = auth.uid() OR public.is_food_coordinator(auth.uid()))));
CREATE POLICY food_events_read ON public.food_order_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.food_orders o WHERE o.id = order_id
                   AND (o.employee_id = auth.uid() OR public.is_food_coordinator(auth.uid()))));

-- Coordinator-only reads.
CREATE POLICY food_exc_read   ON public.food_exceptions FOR SELECT TO authenticated
  USING (public.is_food_coordinator(auth.uid()));
CREATE POLICY food_audit_read ON public.food_audit FOR SELECT TO authenticated
  USING (public.is_food_coordinator(auth.uid()));
CREATE POLICY food_coord_read ON public.food_coordinator_assignments FOR SELECT TO authenticated
  USING (public.is_food_coordinator(auth.uid()));

-- Menu authoring: the ACTIVE coordinator only. Backup access is read-only.
-- These are belt-and-braces: the REVOKE further down removes every direct write
-- privilege, so in practice these policies never fire. They are kept so that if a
-- GRANT ever reappears (Supabase default privileges being re-applied, say), the
-- table is still gated rather than wide open.
CREATE POLICY food_cat_write   ON public.food_categories      FOR ALL TO authenticated
  USING (public.is_active_food_coordinator(auth.uid())) WITH CHECK (public.is_active_food_coordinator(auth.uid()));
CREATE POLICY food_meals_write ON public.food_meals           FOR ALL TO authenticated
  USING (public.is_active_food_coordinator(auth.uid())) WITH CHECK (public.is_active_food_coordinator(auth.uid()));
CREATE POLICY food_per_write   ON public.food_service_periods FOR ALL TO authenticated
  USING (public.is_active_food_coordinator(auth.uid())) WITH CHECK (public.is_active_food_coordinator(auth.uid()));
CREATE POLICY food_clo_write   ON public.food_service_closures FOR ALL TO authenticated
  USING (public.is_active_food_coordinator(auth.uid())) WITH CHECK (public.is_active_food_coordinator(auth.uid()));
CREATE POLICY food_menu_write  ON public.food_menu_items      FOR ALL TO authenticated
  USING (public.is_active_food_coordinator(auth.uid())) WITH CHECK (public.is_active_food_coordinator(auth.uid()));

-- NOTE: there is deliberately NO insert/update policy on food_orders,
-- food_order_items, food_order_events, food_audit or
-- food_coordinator_assignments. Every write to those goes through a
-- SECURITY DEFINER RPC, so neither an employee nor the coordinator can mark a
-- payment successful, forge an order, or appoint themselves.

-- Supabase applies DEFAULT PRIVILEGES that grant ALL on every new table in
-- `public` to anon and authenticated. A bare GRANT SELECT therefore changes
-- nothing, and the write privileges have to be taken away EXPLICITLY. Verified
-- in the sandbox on 2026-10-09: without the REVOKE below, the coordinator could
-- INSERT/UPDATE food_meals directly, which lands a price change with NO row in
-- food_audit — exactly the trail this feature exists to keep.
REVOKE ALL ON public.food_categories, public.food_meals, public.food_service_periods,
               public.food_service_closures, public.food_menu_items, public.food_orders,
               public.food_order_items, public.food_order_events, public.food_exceptions,
               public.food_audit, public.food_coordinator_assignments
  FROM anon, authenticated;

-- Reads are governed by the RLS policies above; writes have exactly one path,
-- the SECURITY DEFINER RPCs, which run as the owner and are unaffected by this.
GRANT SELECT ON public.food_categories, public.food_meals, public.food_service_periods,
                public.food_service_closures, public.food_menu_items, public.food_orders,
                public.food_order_items, public.food_order_events, public.food_exceptions,
                public.food_audit, public.food_coordinator_assignments TO authenticated;

-- Scoped to this feature's tables only — never a schema-wide grant.
GRANT ALL ON public.food_categories, public.food_meals, public.food_service_periods,
             public.food_service_closures, public.food_menu_items, public.food_orders,
             public.food_order_items, public.food_order_events, public.food_exceptions,
             public.food_audit, public.food_coordinator_assignments TO service_role;

-- Historical integrity: an order and its lines are append-only from the client's
-- side; corrections go through the authorised RPCs which post an event row.
CREATE OR REPLACE FUNCTION public.food_no_hard_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $f$
BEGIN RAISE EXCEPTION 'food: % is append-only; archive or cancel instead', TG_TABLE_NAME; END $f$;

CREATE TRIGGER food_orders_no_delete BEFORE DELETE ON public.food_orders
  FOR EACH ROW EXECUTE FUNCTION public.food_no_hard_delete();
CREATE TRIGGER food_meals_no_delete  BEFORE DELETE ON public.food_meals
  FOR EACH ROW EXECUTE FUNCTION public.food_no_hard_delete();
CREATE TRIGGER food_events_no_delete BEFORE DELETE OR UPDATE ON public.food_order_events
  FOR EACH ROW EXECUTE FUNCTION public.food_no_hard_delete();
CREATE TRIGGER food_audit_no_delete  BEFORE DELETE OR UPDATE ON public.food_audit
  FOR EACH ROW EXECUTE FUNCTION public.food_no_hard_delete();

-- ────────────────────── initial coordinator appointment ──────────────────────
-- Installing Food M1 appoints NOBODY. There is deliberately no seed here: an
-- earlier draft auto-appointed a named employee, which was removed (Option 2,
-- 2026-10-14) so no one becomes Food Coordinator — and so receives Food
-- payments — as a side effect of a migration.
--
-- The first coordinator is appointed afterwards through the supported process,
-- food_bootstrap_coordinator(user_id, reason) (20261012120000 / 20261013125000;
-- service_role only, eligible employee, 10+ character reason, refused once a
-- coordinator is seated, written to food_audit). Later changes go through
-- food_transfer_coordinator(). Until then every coordinator-only action is
-- refused by food_require_active_coordinator().
DO $seed$
BEGIN
  -- Prerequisite kept from the removed seed: Food relies on profiles.deleted_at
  -- (staff eligibility). Fail closed, rolling back this whole file, if it is absent.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'profiles'
                    AND column_name = 'deleted_at') THEN
    RAISE EXCEPTION 'food: prerequisite public.profiles.deleted_at is missing';
  END IF;
  RAISE NOTICE 'food: initial coordinator NOT seeded by design; appoint one with food_bootstrap_coordinator()';
END
$seed$;
