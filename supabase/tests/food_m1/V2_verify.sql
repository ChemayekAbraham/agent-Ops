-- ============================================================================
-- V2 — Food M1 structural verification.
--
-- READ-ONLY. Parts 1 and 3 read pg_catalog only and are safe to run when the
-- food tables do not exist. Part 2 reads one food table and is guarded so a
-- missing table reports MISSING instead of raising. No DDL, no DML, no INSERT,
-- no profile creation, nothing that changes any row.
--
-- M1-ONLY VERIFIER. Expectations describe
--   supabase/migrations/20261009120001_food_service_schema_and_coordinator.sql
-- and nothing else. Against a database that also carries M2/M3/M4 this script
-- WILL fail, correctly: M4 adds food_exceptions.resolution_reason (a 98th
-- column) and M2–M4 add 20 functions. Do not "fix" those failures by relaxing
-- the expectations — capture a separate M1–M4 baseline instead.
--
-- WHAT V2 ESTABLISHES / WHAT IT DOES NOT
--   V2 is STRUCTURAL. It compares the catalog against the migration source. It
--   does NOT prove behaviour: nothing here demonstrates that food_orders_read
--   actually hides another employee's order under a real JWT, or that the
--   no-delete triggers actually refuse a delete. Those need a behavioural test
--   executing as a real role, which this file deliberately does not attempt.
--
-- BASELINE STATUS — READ THIS BEFORE TRUSTING A PASS
--   Sections 2.6b (policy expressions) and 2.8b (function bodies) are PENDING.
--   Their expected values have NOT been measured and are NOT written here. They
--   must be captured from a successful FRESH M1-ONLY installation in the
--   separately authorised disposable-project test, then reviewed line by line
--   against the migration source before being accepted as docs/food-m1-baseline.txt.
--   The disposable sandbox 73ddf668 is NOT an acceptable source: it carries
--   M2–M4 and would bake their objects into the M1 baseline.
--   An unreviewed capture is not a baseline. It is a photograph of whatever
--   happened to be installed.
--
-- PROVENANCE OF THE EXPECTED VALUES HERE
--   Column specs, CHECK definitions, FK definitions, index definitions, trigger
--   bitmasks and the RLS flags were derived from the migration source and
--   cross-checked against a live catalog. Every one of them is a DEPARSED form
--   produced by pg_get_constraintdef / pg_indexes.indexdef / format_type, so
--   they are sensitive to the PostgreSQL major version. Authored against
--   PostgreSQL 17.x. On a different major version, re-confirm the deparsed
--   text before treating a mismatch as a defect.
--
-- HOW TO RUN
--   psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f V2_verify.sql
--   Part 1 is a single statement, so it also works in a client that returns
--   only the last result set. Parts 2 and 3 are run individually.
--
-- ============================================================================
-- THE COMBINED VERDICT — THERE IS NO SINGLE SQL ROW THAT GIVES IT
--
-- No statement here can see another statement's results, and nothing is
-- persisted between them. A combined verdict row would therefore have to
-- either re-run everything or read a stored baseline that does not exist, so
-- NONE IS PROVIDED. The combination is a MANUAL decision, and this is the
-- procedure. Part 1's PENDING is not a full verification and must never be
-- recorded as one.
--
-- REQUIRED OUTPUTS - all five, from the SAME database, in one sitting:
--   R1  V1_triage.sql statement 1  -> A. OVERALL, and section D all OK (0)
--   R2  V1_triage.sql statement 2  -> PASS
--   R3  V2 part 1                  -> V2.0 OVERALL, and every V2.x row
--   R4  V2 part 2A or 2B           -> V2.11 PASS  (2B if notices are dropped)
--   R5  V2 part 3 queries A and B  -> captured AND reviewed per the procedure
--                                     at part 3, then frozen as the baseline
--
-- THE DECISION:
--   FAIL     if ANY of R1-R5 reports a failure, or a required object is
--            missing, or an invariant is violated. One FAIL outranks
--            everything else.
--   PENDING  if nothing fails but any of R1-R5 is absent, unread, reports
--            PENDING, or has no REVIEWED baseline. A capture that nobody has
--            read against the migration source is not a baseline.
--   PASS     only when all five are present, all five were actually read, the
--            part 3 baseline has been reviewed and signed off, and none
--            reports FAIL or PENDING.
--
-- A check whose output you did not see has NOT passed. Record the five
-- results and the decision somewhere durable; this file cannot do it for you.
-- ============================================================================


-- ============================================================================
-- PART 1 — sections V2.1 to V2.10, plus the OVERALL verdict. Catalog only.
-- One statement.
--
-- HOW TO READ IT — PENDING IS NOT A PASS.
--   Read the 'V2.0 OVERALL' row first. Precedence is FAIL > PENDING > PASS:
--     FAIL    any required check failed.
--     PENDING nothing failed, but at least one required check is unverified.
--     PASS    every required check was evaluated and passed.
--   Part 1 can NEVER report PASS on its own: three required checks live
--   outside it (V2.6b policy expressions, V2.8b function bodies, V2.11
--   coordinator identity), so the best part 1 alone can say is PENDING. A full
--   pass needs part 1 PENDING-free-but-for-those three, part 2 PASS, and the
--   part 3 baselines captured AND reviewed. Do not record PENDING as a pass,
--   and do not report a check as passed if you did not see its result.
--
-- Every set comparison compares MULTIPLICITIES, not bare existence. NOTE that
-- with the keys used here the catalog already enforces uniqueness, so the
-- "count mismatch" arm is not reachable in practice; it is a cheap invariant
-- assertion, not working duplicate protection. Do not cite it as such.
-- ============================================================================

WITH m1_tables(t) AS (VALUES
  ('food_categories'),('food_meals'),('food_service_periods'),('food_service_closures'),
  ('food_menu_items'),('food_orders'),('food_order_items'),('food_order_events'),
  ('food_exceptions'),('food_audit'),('food_coordinator_assignments')),

-- How many of the 11 exist as ordinary tables. Guards the checks that would
-- otherwise be VACUOUSLY TRUE on an empty database - "no non-food table
-- references a food table" is trivially satisfied when there is no food table,
-- and reporting that as PASS invites it to be read as a verified result.
schema_present(n) AS (
  SELECT count(*)::int FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN m1_tables ON m1_tables.t = c.relname
   WHERE ns.nspname = 'public' AND c.relkind = 'r'),

-- ───────────────────────────── V2.1 columns (97) ──────────────────────────
-- table|column|format_type|NN or NULL|default (or '-')
exp_col(sig) AS (VALUES
 ('food_audit|id|uuid|NN|gen_random_uuid()'),
 ('food_audit|entity|text|NN|-'),
 ('food_audit|entity_id|uuid|NULL|-'),
 ('food_audit|action|text|NN|-'),
 ('food_audit|before_val|jsonb|NULL|-'),
 ('food_audit|after_val|jsonb|NULL|-'),
 ('food_audit|reason|text|NULL|-'),
 ('food_audit|actor_id|uuid|NN|-'),
 ('food_audit|created_at|timestamp with time zone|NN|now()'),

 ('food_categories|id|uuid|NN|gen_random_uuid()'),
 ('food_categories|name|text|NN|-'),
 ('food_categories|sort_order|integer|NN|100'),
 ('food_categories|archived_at|timestamp with time zone|NULL|-'),
 ('food_categories|created_by|uuid|NN|-'),
 ('food_categories|created_at|timestamp with time zone|NN|now()'),

 ('food_coordinator_assignments|id|uuid|NN|gen_random_uuid()'),
 ('food_coordinator_assignments|coordinator_id|uuid|NN|-'),
 ('food_coordinator_assignments|access_level|text|NN|''active''::text'),
 ('food_coordinator_assignments|assigned_by|uuid|NULL|-'),
 ('food_coordinator_assignments|assigned_at|timestamp with time zone|NN|now()'),
 ('food_coordinator_assignments|revoked_at|timestamp with time zone|NULL|-'),
 ('food_coordinator_assignments|revoked_by|uuid|NULL|-'),
 ('food_coordinator_assignments|handover_mode|text|NULL|-'),
 ('food_coordinator_assignments|reason|text|NULL|-'),

 -- 7 columns. food_exceptions.resolution_reason is M4's, NOT M1's.
 ('food_exceptions|id|uuid|NN|gen_random_uuid()'),
 ('food_exceptions|order_id|uuid|NULL|-'),
 ('food_exceptions|kind|text|NN|-'),
 ('food_exceptions|detail|jsonb|NN|''{}''::jsonb'),
 ('food_exceptions|resolved_at|timestamp with time zone|NULL|-'),
 ('food_exceptions|resolved_by|uuid|NULL|-'),
 ('food_exceptions|created_at|timestamp with time zone|NN|now()'),

 ('food_meals|id|uuid|NN|gen_random_uuid()'),
 ('food_meals|name|text|NN|-'),
 ('food_meals|description|text|NULL|-'),
 ('food_meals|image_path|text|NULL|-'),
 ('food_meals|category_id|uuid|NULL|-'),
 ('food_meals|price_ugx|numeric(14,2)|NN|-'),
 ('food_meals|status|text|NN|''draft''::text'),
 ('food_meals|archived_at|timestamp with time zone|NULL|-'),
 ('food_meals|created_by|uuid|NN|-'),
 ('food_meals|created_at|timestamp with time zone|NN|now()'),
 ('food_meals|updated_at|timestamp with time zone|NN|now()'),

 ('food_menu_items|id|uuid|NN|gen_random_uuid()'),
 ('food_menu_items|service_date|date|NN|-'),
 ('food_menu_items|period_id|uuid|NN|-'),
 ('food_menu_items|meal_id|uuid|NN|-'),
 ('food_menu_items|price_ugx|numeric(14,2)|NN|-'),
 ('food_menu_items|servings_total|integer|NULL|-'),
 ('food_menu_items|servings_reserved|integer|NN|0'),
 ('food_menu_items|sold_out|boolean|NN|false'),
 ('food_menu_items|published_at|timestamp with time zone|NULL|-'),
 ('food_menu_items|created_by|uuid|NN|-'),
 ('food_menu_items|created_at|timestamp with time zone|NN|now()'),

 ('food_order_events|id|uuid|NN|gen_random_uuid()'),
 ('food_order_events|order_id|uuid|NN|-'),
 ('food_order_events|event_type|text|NN|-'),
 ('food_order_events|from_status|text|NULL|-'),
 ('food_order_events|to_status|text|NULL|-'),
 ('food_order_events|note|text|NULL|-'),
 ('food_order_events|actor_id|uuid|NN|-'),
 ('food_order_events|created_at|timestamp with time zone|NN|now()'),

 ('food_order_items|id|uuid|NN|gen_random_uuid()'),
 ('food_order_items|order_id|uuid|NN|-'),
 ('food_order_items|menu_item_id|uuid|NN|-'),
 ('food_order_items|meal_id|uuid|NN|-'),
 ('food_order_items|meal_name|text|NN|-'),
 ('food_order_items|meal_description|text|NULL|-'),
 ('food_order_items|unit_price_ugx|numeric(14,2)|NN|-'),
 ('food_order_items|quantity|integer|NN|-'),
 ('food_order_items|line_total_ugx|numeric(14,2)|NN|-'),

 ('food_orders|id|uuid|NN|gen_random_uuid()'),
 ('food_orders|order_reference|text|NN|-'),
 ('food_orders|employee_id|uuid|NN|-'),
 ('food_orders|service_date|date|NN|-'),
 ('food_orders|period_id|uuid|NN|-'),
 ('food_orders|total_ugx|numeric(14,2)|NN|-'),
 ('food_orders|payment_status|text|NN|''pending_payment''::text'),
 ('food_orders|fulfilment_status|text|NN|''confirmed''::text'),
 ('food_orders|transaction_group_id|uuid|NULL|-'),
 ('food_orders|idempotency_key|text|NN|-'),
 ('food_orders|special_instructions|text|NULL|-'),
 ('food_orders|placed_at|timestamp with time zone|NN|now()'),
 ('food_orders|paid_at|timestamp with time zone|NULL|-'),
 ('food_orders|cancelled_at|timestamp with time zone|NULL|-'),
 ('food_orders|stock_released|boolean|NN|false'),

 ('food_service_closures|closure_date|date|NN|-'),
 ('food_service_closures|reason|text|NN|-'),
 ('food_service_closures|created_by|uuid|NN|-'),
 ('food_service_closures|created_at|timestamp with time zone|NN|now()'),

 ('food_service_periods|id|uuid|NN|gen_random_uuid()'),
 ('food_service_periods|name|text|NN|-'),
 ('food_service_periods|ordering_opens_at|time without time zone|NN|-'),
 ('food_service_periods|ordering_closes_at|time without time zone|NN|-'),
 ('food_service_periods|collection_instructions|text|NULL|-'),
 ('food_service_periods|max_qty_per_employee|integer|NULL|-'),
 ('food_service_periods|active|boolean|NN|true'),
 ('food_service_periods|created_at|timestamp with time zone|NN|now()')),

act_col(sig) AS (
  SELECT c.relname || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
         || '|' || CASE WHEN a.attnotnull THEN 'NN' ELSE 'NULL' END
         || '|' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '-')
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN m1_tables ON m1_tables.t = c.relname
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND a.attnum > 0 AND NOT a.attisdropped),

d_col AS (
  SELECT sig AS item, COALESCE(e.n,0) AS exp_n, COALESCE(a.n,0) AS act_n
    FROM (SELECT sig, count(*) AS n FROM exp_col GROUP BY sig) e
    FULL OUTER JOIN (SELECT sig, count(*) AS n FROM act_col GROUP BY sig) a USING (sig)
   WHERE COALESCE(e.n,0) <> COALESCE(a.n,0)),

-- ─────────────────────── V2.2 CHECK constraints (20) ──────────────────────
-- Compared by table + pg_get_constraintdef, NEVER by name: three of M1's
-- generated constraint names are truncated at the 63-character identifier
-- limit (food_coordinator_assignments_acces, ..._hando,
-- food_service_periods_max_qty_per_employee_) and are not a stable key.
exp_chk(sig) AS (VALUES
 ('food_categories|CHECK ((length(btrim(name)) > 0))'),
 ('food_coordinator_assignments|CHECK ((access_level = ANY (ARRAY[''active''::text, ''backup''::text])))'),
 ('food_coordinator_assignments|CHECK ((handover_mode = ANY (ARRAY[''full_transfer''::text, ''transfer_with_backup''::text])))'),
 ('food_meals|CHECK ((length(btrim(name)) > 0))'),
 ('food_meals|CHECK ((price_ugx >= (0)::numeric))'),
 ('food_meals|CHECK ((status = ANY (ARRAY[''draft''::text, ''published''::text, ''archived''::text])))'),
 ('food_menu_items|CHECK ((price_ugx >= (0)::numeric))'),
 ('food_menu_items|CHECK ((servings_reserved >= 0))'),
 ('food_menu_items|CHECK (((servings_total IS NULL) OR (servings_total >= 0)))'),
 ('food_menu_items|CHECK (((servings_total IS NULL) OR (servings_reserved <= servings_total)))'),
 ('food_order_items|CHECK ((line_total_ugx = round((unit_price_ugx * (quantity)::numeric), 2)))'),
 ('food_order_items|CHECK ((line_total_ugx >= (0)::numeric))'),
 ('food_order_items|CHECK ((quantity > 0))'),
 ('food_order_items|CHECK ((unit_price_ugx >= (0)::numeric))'),
 ('food_orders|CHECK ((fulfilment_status = ANY (ARRAY[''confirmed''::text, ''preparing''::text, ''ready''::text, ''collected''::text, ''delivered''::text, ''cancelled''::text])))'),
 ('food_orders|CHECK (((payment_status <> ''paid''::text) OR (transaction_group_id IS NOT NULL)))'),
 ('food_orders|CHECK ((payment_status = ANY (ARRAY[''pending_payment''::text, ''paid''::text, ''payment_failed''::text, ''refund_pending''::text, ''refunded''::text])))'),
 ('food_orders|CHECK ((total_ugx >= (0)::numeric))'),
 ('food_service_periods|CHECK ((ordering_closes_at > ordering_opens_at))'),
 ('food_service_periods|CHECK (((max_qty_per_employee IS NULL) OR (max_qty_per_employee > 0)))')),

act_chk(sig) AS (
  SELECT c.relname || '|' || pg_get_constraintdef(k.oid)
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN m1_tables ON m1_tables.t = c.relname
   WHERE n.nspname = 'public' AND k.contype = 'c'),

d_chk AS (
  SELECT sig AS item, COALESCE(e.n,0) AS exp_n, COALESCE(a.n,0) AS act_n
    FROM (SELECT sig, count(*) AS n FROM exp_chk GROUP BY sig) e
    FULL OUTER JOIN (SELECT sig, count(*) AS n FROM act_chk GROUP BY sig) a USING (sig)
   WHERE COALESCE(e.n,0) <> COALESCE(a.n,0)),

-- ───────────────────────── V2.3 foreign keys (20) ─────────────────────────
-- 20 FKs, not 11. Eleven reference public.profiles; NINE are internal to the
-- food set and were omitted from an earlier draft of these expectations.
-- pg_get_constraintdef prints only NON-DEFAULT referential actions, so the one
-- ON DELETE CASCADE is visible in its signature and the other nineteen are
-- NO ACTION by the absence of any clause. An unexpected ON DELETE SET NULL or
-- ON UPDATE CASCADE therefore surfaces as an UNEXPECTED row.
exp_fk(sig) AS (VALUES
 ('food_audit|FOREIGN KEY (actor_id) REFERENCES profiles(id)'),
 ('food_categories|FOREIGN KEY (created_by) REFERENCES profiles(id)'),
 ('food_coordinator_assignments|FOREIGN KEY (assigned_by) REFERENCES profiles(id)'),
 ('food_coordinator_assignments|FOREIGN KEY (coordinator_id) REFERENCES profiles(id)'),
 ('food_coordinator_assignments|FOREIGN KEY (revoked_by) REFERENCES profiles(id)'),
 ('food_exceptions|FOREIGN KEY (order_id) REFERENCES food_orders(id)'),
 ('food_exceptions|FOREIGN KEY (resolved_by) REFERENCES profiles(id)'),
 ('food_meals|FOREIGN KEY (category_id) REFERENCES food_categories(id)'),
 ('food_meals|FOREIGN KEY (created_by) REFERENCES profiles(id)'),
 ('food_menu_items|FOREIGN KEY (created_by) REFERENCES profiles(id)'),
 ('food_menu_items|FOREIGN KEY (meal_id) REFERENCES food_meals(id)'),
 ('food_menu_items|FOREIGN KEY (period_id) REFERENCES food_service_periods(id)'),
 ('food_order_events|FOREIGN KEY (actor_id) REFERENCES profiles(id)'),
 ('food_order_events|FOREIGN KEY (order_id) REFERENCES food_orders(id)'),
 ('food_order_items|FOREIGN KEY (meal_id) REFERENCES food_meals(id)'),
 ('food_order_items|FOREIGN KEY (menu_item_id) REFERENCES food_menu_items(id)'),
 ('food_order_items|FOREIGN KEY (order_id) REFERENCES food_orders(id) ON DELETE CASCADE'),
 ('food_orders|FOREIGN KEY (employee_id) REFERENCES profiles(id)'),
 ('food_orders|FOREIGN KEY (period_id) REFERENCES food_service_periods(id)'),
 ('food_service_closures|FOREIGN KEY (created_by) REFERENCES profiles(id)')),

act_fk(sig) AS (
  SELECT c.relname || '|' || pg_get_constraintdef(k.oid)
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN m1_tables ON m1_tables.t = c.relname
   WHERE n.nspname = 'public' AND k.contype = 'f'),

d_fk AS (
  SELECT sig AS item, COALESCE(e.n,0) AS exp_n, COALESCE(a.n,0) AS act_n
    FROM (SELECT sig, count(*) AS n FROM exp_fk GROUP BY sig) e
    FULL OUTER JOIN (SELECT sig, count(*) AS n FROM act_fk GROUP BY sig) a USING (sig)
   WHERE COALESCE(e.n,0) <> COALESCE(a.n,0)),

d_fk_unvalidated AS (
  SELECT c.relname || '.' || k.conname AS item
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN m1_tables ON m1_tables.t = c.relname
   WHERE n.nspname = 'public' AND k.contype = 'f' AND NOT k.convalidated),

d_fk_cascade AS (
  SELECT count(*) FILTER (WHERE k.confdeltype = 'c') AS cascades,
         count(*) FILTER (WHERE k.confdeltype = 'a' AND k.confupdtype = 'a') AS no_action
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN m1_tables ON m1_tables.t = c.relname
   WHERE n.nspname = 'public' AND k.contype = 'f'),

-- ──────────────────────── V2.4 index definitions (25) ─────────────────────
-- Full indexdef, so uniqueness, column order, DESC, the (true) expression and
-- every partial predicate are all in scope. A lost WHERE clause on
-- food_one_active_coordinator would permit two active coordinators; a lost DESC
-- changes nothing semantically but indicates an unreviewed rebuild.
exp_idx(def) AS (VALUES
 ('CREATE INDEX food_audit_entity_idx ON public.food_audit USING btree (entity, entity_id, created_at DESC)'),
 ('CREATE INDEX food_coordinator_lookup ON public.food_coordinator_assignments USING btree (coordinator_id) WHERE (revoked_at IS NULL)'),
 ('CREATE INDEX food_meals_status_idx ON public.food_meals USING btree (status) WHERE (archived_at IS NULL)'),
 ('CREATE INDEX food_menu_items_day_idx ON public.food_menu_items USING btree (service_date, period_id)'),
 ('CREATE UNIQUE INDEX food_one_active_coordinator ON public.food_coordinator_assignments USING btree ((true)) WHERE ((revoked_at IS NULL) AND (access_level = ''active''::text))'),
 ('CREATE INDEX food_order_events_order_idx ON public.food_order_events USING btree (order_id, created_at)'),
 ('CREATE INDEX food_order_items_order_idx ON public.food_order_items USING btree (order_id)'),
 ('CREATE INDEX food_orders_employee_idx ON public.food_orders USING btree (employee_id, placed_at DESC)'),
 ('CREATE INDEX food_orders_queue_idx ON public.food_orders USING btree (service_date, fulfilment_status) WHERE (payment_status = ''paid''::text)'),
 ('CREATE UNIQUE INDEX food_audit_pkey ON public.food_audit USING btree (id)'),
 ('CREATE UNIQUE INDEX food_categories_name_key ON public.food_categories USING btree (name)'),
 ('CREATE UNIQUE INDEX food_categories_pkey ON public.food_categories USING btree (id)'),
 ('CREATE UNIQUE INDEX food_coordinator_assignments_pkey ON public.food_coordinator_assignments USING btree (id)'),
 ('CREATE UNIQUE INDEX food_exceptions_pkey ON public.food_exceptions USING btree (id)'),
 ('CREATE UNIQUE INDEX food_meals_pkey ON public.food_meals USING btree (id)'),
 ('CREATE UNIQUE INDEX food_menu_items_pkey ON public.food_menu_items USING btree (id)'),
 ('CREATE UNIQUE INDEX food_menu_items_service_date_period_id_meal_id_key ON public.food_menu_items USING btree (service_date, period_id, meal_id)'),
 ('CREATE UNIQUE INDEX food_order_events_pkey ON public.food_order_events USING btree (id)'),
 ('CREATE UNIQUE INDEX food_order_items_pkey ON public.food_order_items USING btree (id)'),
 ('CREATE UNIQUE INDEX food_orders_idempotency_key_key ON public.food_orders USING btree (idempotency_key)'),
 ('CREATE UNIQUE INDEX food_orders_order_reference_key ON public.food_orders USING btree (order_reference)'),
 ('CREATE UNIQUE INDEX food_orders_pkey ON public.food_orders USING btree (id)'),
 ('CREATE UNIQUE INDEX food_service_closures_pkey ON public.food_service_closures USING btree (closure_date)'),
 ('CREATE UNIQUE INDEX food_service_periods_name_key ON public.food_service_periods USING btree (name)'),
 ('CREATE UNIQUE INDEX food_service_periods_pkey ON public.food_service_periods USING btree (id)')),

act_idx(def) AS (
  SELECT i.indexdef FROM pg_indexes i
    JOIN m1_tables ON m1_tables.t = i.tablename
   WHERE i.schemaname = 'public'),

d_idx AS (
  SELECT def AS item, COALESCE(e.n,0) AS exp_n, COALESCE(a.n,0) AS act_n
    FROM (SELECT def, count(*) AS n FROM exp_idx GROUP BY def) e
    FULL OUTER JOIN (SELECT def, count(*) AS n FROM act_idx GROUP BY def) a USING (def)
   WHERE COALESCE(e.n,0) <> COALESCE(a.n,0)),

-- ─────────────────── V2.5 RLS enabled and NOT forced (11) ─────────────────
-- M1 uses ENABLE, never FORCE. The owner must keep its RLS bypass: the
-- SECURITY DEFINER RPCs run as the owner, so FORCE would break every write
-- path in the feature. relforcerowsecurity = false is a requirement, not an
-- oversight.
d_rls AS (
  SELECT t.t AS item,
         CASE WHEN c.oid IS NULL              THEN 'FAIL - table missing'
              WHEN NOT c.relrowsecurity       THEN 'FAIL - RLS not enabled'
              WHEN c.relforcerowsecurity      THEN 'FAIL - RLS FORCED (breaks the SECURITY DEFINER RPCs)'
         END AS problem
    FROM m1_tables t
    LEFT JOIN pg_class c ON c.relname = t.t AND c.relkind = 'r'
         AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
   WHERE c.oid IS NULL OR NOT c.relrowsecurity OR c.relforcerowsecurity),

-- ────────────────────────── V2.6 policy shape (16) ────────────────────────
-- Table, name, command, PERMISSIVE/RESTRICTIVE mode, roles, and whether
-- qual / with_check are present.
-- Expression TEXT is NOT compared here - see V2.6b, which is PENDING.
-- Six tables must carry NO write policy at all: food_orders, food_order_items,
-- food_order_events, food_exceptions, food_audit and
-- food_coordinator_assignments. (The in-migration comment at lines 267-271
-- names only five - it omits food_exceptions. The comment is wrong; six is
-- correct, and any seventeenth policy surfaces as UNEXPECTED below.)
-- PERMISSIVENESS IS PART OF THE SIGNATURE. M1 writes every policy with the
-- default mode, so all 16 are PERMISSIVE (grep "AS RESTRICTIVE" in the
-- migration returns 0). Recreating one AS RESTRICTIVE leaves the table, name,
-- command, roles, qual AND with_check byte-identical, so without this field
-- the change passes V2.6 - and it also passes V2.6b, because the deparsed
-- expression text is unchanged too. Nothing else in this suite can see it.
-- The semantics invert: restrictive policies are ANDed with the permissive
-- set rather than ORed into it, so a restrictive food_orders_read with no
-- permissive SELECT policy blocks every read, and flipping a *_write policy
-- while adding a permissive one opens writes.
-- The expected values below are read off the migration source, not captured
-- from any database.
exp_pol(sig) AS (VALUES
 ('food_categories|food_cat_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_service_periods|food_periods_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_service_closures|food_closures_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_meals|food_meals_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_menu_items|food_menu_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_orders|food_orders_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_order_items|food_items_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_order_events|food_events_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_exceptions|food_exc_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_audit|food_audit_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_coordinator_assignments|food_coord_read|SELECT|PERMISSIVE|{authenticated}|qual|no_check'),
 ('food_categories|food_cat_write|ALL|PERMISSIVE|{authenticated}|qual|has_check'),
 ('food_meals|food_meals_write|ALL|PERMISSIVE|{authenticated}|qual|has_check'),
 ('food_service_periods|food_per_write|ALL|PERMISSIVE|{authenticated}|qual|has_check'),
 ('food_service_closures|food_clo_write|ALL|PERMISSIVE|{authenticated}|qual|has_check'),
 ('food_menu_items|food_menu_write|ALL|PERMISSIVE|{authenticated}|qual|has_check')),

-- pg_policies.permissive is text, 'PERMISSIVE' or 'RESTRICTIVE'. COALESCE
-- guards the field so a NULL could never collapse the whole signature to NULL
-- and make the row vanish from the comparison instead of failing it.
act_pol(sig) AS (
  SELECT p.tablename || '|' || p.policyname || '|' || p.cmd
         || '|' || COALESCE(p.permissive, 'UNKNOWN-PERMISSIVENESS')
         || '|' || p.roles::text
         || '|' || CASE WHEN p.qual IS NULL THEN 'no_qual' ELSE 'qual' END
         || '|' || CASE WHEN p.with_check IS NULL THEN 'no_check' ELSE 'has_check' END
    FROM pg_policies p JOIN m1_tables ON m1_tables.t = p.tablename
   WHERE p.schemaname = 'public'),

d_pol AS (
  SELECT sig AS item, COALESCE(e.n,0) AS exp_n, COALESCE(a.n,0) AS act_n
    FROM (SELECT sig, count(*) AS n FROM exp_pol GROUP BY sig) e
    FULL OUTER JOIN (SELECT sig, count(*) AS n FROM act_pol GROUP BY sig) a USING (sig)
   WHERE COALESCE(e.n,0) <> COALESCE(a.n,0)),

-- ───────────────────────────── V2.7 table ACLs ────────────────────────────
-- Compared as a SET (<@ both ways), not as a string: ACL element order is
-- grant order and is not a contract, and a string compare would also be
-- collation-sensitive. Expected per table:
--   anon            ABSENT ENTIRELY (not "present with no writes")
--   authenticated   r  (SELECT) and nothing else
--   service_role    arwdDxtm (all seven)
--   postgres (owner) arwdDxtm
-- NULL relacl - what it actually means, and why it still FAILS here.
--   A null relacl means no explicit ACL has ever been recorded for the table.
--   The effective privileges are then PostgreSQL's BUILT-IN default for a
--   relation: the OWNER holds everything and PUBLIC holds nothing. It does NOT
--   mean anon or authenticated hold anything - that is the opposite of the
--   truth, and an earlier draft of this comment said so wrongly.
--   It fails here for a different reason: M1 requires the EXPLICIT grants
--   authenticated=r and service_role=arwdDxtm, and a null ACL has neither, so
--   authenticated cannot read and the feature is broken. FAIL for "required
--   grants absent", never for "defaults still in force".
--   In a Supabase project ALTER DEFAULT PRIVILEGES writes an explicit ACL at
--   CREATE TABLE time, so the DANGEROUS state is a NON-null ACL that still
--   lists anon or gives authenticated more than r. That is what the set
--   comparison below catches. V1's b13/b14/b15 use this same reasoning.
--   Caveat: relacl is the recorded grant, not the whole story. Effective
--   access can still differ through role membership (a grantee that is a
--   member of another role) and relacl does not show column-level grants.
--   Those are out of scope for a structural check.
acl_tbl AS (
  SELECT t.t AS item,
         c.oid IS NULL AS missing,
         (SELECT array_agg(x::text) FROM unnest(c.relacl) x) AS acl
    FROM m1_tables t
    LEFT JOIN pg_class c ON c.relname = t.t AND c.relkind = 'r'
         AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')),

d_acl AS (
  SELECT item,
         CASE WHEN missing   THEN 'FAIL - table missing'
              WHEN acl IS NULL THEN 'FAIL - null ACL: M1''s required explicit grants (authenticated=r, service_role=arwdDxtm) are absent, so authenticated cannot read'
              ELSE 'FAIL - ACL drift: ' || array_to_string(acl, ' | ')
         END AS problem
    FROM acl_tbl
   WHERE missing OR acl IS NULL
      OR NOT (acl <@ ARRAY['postgres=arwdDxtm/postgres',
                           'service_role=arwdDxtm/postgres',
                           'authenticated=r/postgres']
              AND ARRAY['postgres=arwdDxtm/postgres',
                        'service_role=arwdDxtm/postgres',
                        'authenticated=r/postgres'] <@ acl)),

-- ─────────────── V2.8 function signatures, security, config, ACL ──────────
-- M1 creates exactly three. Comparison is by SIGNATURE, so an overload such as
-- is_food_coordinator(text) appears as UNEXPECTED rather than passing as the
-- uuid version.
exp_fn(sig) AS (VALUES
 ('is_food_coordinator(uuid)'),
 ('is_active_food_coordinator(uuid)'),
 ('food_no_hard_delete()')),

-- rettype is carried as its own column rather than folded into `sig`, so the
-- identity signature stays exactly as exp_fn declares it and the `f.sig IN (…)`
-- predicates in d_fn_attr and d_fn_acl keep working unchanged. The return type
-- is asserted in d_fn_attr alongside the other per-function attributes.
-- pg_get_function_result renders pg_catalog base types unqualified regardless
-- of search_path, so 'boolean' and 'trigger' are stable expected values.
act_fn(sig, secdef, vol, cfg, rettype, oid) AS (
  SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         p.prosecdef, p.provolatile, array_to_string(p.proconfig, ','),
         pg_get_function_result(p.oid), p.oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('is_food_coordinator','is_active_food_coordinator','food_no_hard_delete')),

d_fn_set AS (
  SELECT sig AS item, COALESCE(e.n,0) AS exp_n, COALESCE(a.n,0) AS act_n
    FROM (SELECT sig, count(*) AS n FROM exp_fn GROUP BY sig) e
    FULL OUTER JOIN (SELECT sig, count(*) AS n FROM act_fn GROUP BY sig) a USING (sig)
   WHERE COALESCE(e.n,0) <> COALESCE(a.n,0)),

-- Attribute requirements, derived from the migration source:
--   is_food_coordinator(uuid)         RETURNS boolean  LANGUAGE sql STABLE SECURITY DEFINER   (M1 line 190)
--   is_active_food_coordinator(uuid)  RETURNS boolean  LANGUAGE sql STABLE SECURITY DEFINER   (M1 line 198)
--   food_no_hard_delete()             RETURNS trigger  LANGUAGE plpgsql VOLATILE SECURITY INVOKER (M1 line 300)
-- all three SET search_path = public. A DEFINER function without search_path is
-- a hijack; promoting food_no_hard_delete to DEFINER would make it a bypass.
-- The return type is asserted here because the identity signature covers
-- ARGUMENTS only - is_food_coordinator(uuid) returning something other than
-- boolean would pass d_fn_set untouched. This asserts the DECLARED result type
-- and nothing more: it says nothing about what the body computes, which stays
-- pending until the V2.8b baseline is captured and reviewed.
d_fn_attr AS (
  SELECT f.sig AS item,
         CASE
           WHEN f.sig IN ('is_food_coordinator(uuid)','is_active_food_coordinator(uuid)')
                AND NOT f.secdef                     THEN 'FAIL - must be SECURITY DEFINER'
           WHEN f.sig IN ('is_food_coordinator(uuid)','is_active_food_coordinator(uuid)')
                AND f.vol <> 's'                     THEN 'FAIL - must be STABLE, found volatility ' || f.vol
           WHEN f.sig IN ('is_food_coordinator(uuid)','is_active_food_coordinator(uuid)')
                AND f.rettype <> 'boolean'           THEN 'FAIL - must RETURN boolean, found ' || f.rettype
           WHEN f.sig = 'food_no_hard_delete()' AND f.secdef
                                                     THEN 'FAIL - must be SECURITY INVOKER'
           WHEN f.sig = 'food_no_hard_delete()' AND f.vol <> 'v'
                                                     THEN 'FAIL - must be VOLATILE, found volatility ' || f.vol
           WHEN f.sig = 'food_no_hard_delete()' AND f.rettype <> 'trigger'
                                                     THEN 'FAIL - must RETURN trigger, found ' || f.rettype
           WHEN f.cfg IS DISTINCT FROM 'search_path=public'
                                                     THEN 'FAIL - proconfig must be search_path=public, found ' || COALESCE(f.cfg,'(none)')
         END AS problem
    FROM act_fn f
   WHERE (f.sig IN ('is_food_coordinator(uuid)','is_active_food_coordinator(uuid)')
            AND (NOT f.secdef OR f.vol <> 's' OR f.rettype <> 'boolean'))
      OR (f.sig = 'food_no_hard_delete()' AND (f.secdef OR f.vol <> 'v' OR f.rettype <> 'trigger'))
      OR f.cfg IS DISTINCT FROM 'search_path=public'),

-- Function EXECUTE privileges. M1 states exactly this and no more:
--   REVOKE EXECUTE ... FROM PUBLIC, anon;  GRANT EXECUTE ... TO authenticated;
-- for the two permission functions only. These three invariants are therefore
-- the contract, and they are checked as hard failures.
--   food_no_hard_delete gets NO grant statement in M1, so it KEEPS the platform
--   default privileges - on Supabase that means PUBLIC and anon retain EXECUTE.
--   That is expected and inert: a trigger function invoked directly raises
--   0A000. Asserting it as revoked would be a false alarm, so it is reported
--   for review in part 3 rather than failed here.
--   The service_role=X entry seen on all three also comes from platform default
--   privileges, not from M1, so it is likewise not asserted.
d_fn_acl AS (
  SELECT f.sig || ' :: ' || msg AS item
    FROM act_fn f
    CROSS JOIN LATERAL (
      SELECT 'PUBLIC still holds EXECUTE (M1 revokes it)' AS msg
       WHERE f.sig <> 'food_no_hard_delete()'
         AND EXISTS (SELECT 1 FROM aclexplode(
                       COALESCE((SELECT proacl FROM pg_proc WHERE oid = f.oid),
                                acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = f.oid)))) ae
                      WHERE ae.grantee = 0 AND ae.privilege_type = 'EXECUTE')
      UNION ALL
      SELECT 'anon still holds EXECUTE (M1 revokes it)'
       WHERE f.sig <> 'food_no_hard_delete()'
         AND EXISTS (SELECT 1 FROM aclexplode(
                       COALESCE((SELECT proacl FROM pg_proc WHERE oid = f.oid),
                                acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = f.oid)))) ae
                      JOIN pg_roles r ON r.oid = ae.grantee
                      WHERE r.rolname = 'anon' AND ae.privilege_type = 'EXECUTE')
      UNION ALL
      SELECT 'authenticated does NOT hold EXECUTE (M1 grants it)'
       WHERE f.sig <> 'food_no_hard_delete()'
         AND NOT EXISTS (SELECT 1 FROM aclexplode(
                           COALESCE((SELECT proacl FROM pg_proc WHERE oid = f.oid),
                                    acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = f.oid)))) ae
                          JOIN pg_roles r ON r.oid = ae.grantee
                          WHERE r.rolname = 'authenticated' AND ae.privilege_type = 'EXECUTE')
    ) q),

-- ─────────────────────────── V2.9 triggers (4) ────────────────────────────
-- tgtype is a bitmask: 1 ROW + 2 BEFORE + 8 DELETE = 11; + 16 UPDATE = 27.
--   food_orders_no_delete  / food_meals_no_delete  -> 11 (BEFORE DELETE)
--   food_events_no_delete  / food_audit_no_delete  -> 27 (BEFORE DELETE OR UPDATE)
-- A 27 that reads 11 means THE AUDIT TRAIL BECAME UPDATE-ABLE. tgenabled 'O' is
-- enabled-in-origin; 'D' means someone disabled it, which a name-only check
-- would not notice.
--
-- THE WHEN CLAUSE IS PART OF THE SIGNATURE. M1 declares no WHEN on any of the
-- four (lines 304-311: BEFORE … FOR EACH ROW EXECUTE FUNCTION, nothing else),
-- so pg_trigger.tgqual must be NULL on all four. Without this field a trigger
-- recreated with WHEN (false) keeps an identical table, name, tgtype,
-- tgenabled and function - it passes every other check and never fires, which
-- silently disarms the no-delete and audit protection.
--
-- Why tgqual and NOT pg_get_triggerdef(oid, true): that function deparses the
-- function reference through generate_function_name, which schema-qualifies
-- only when the function is NOT visible in the caller's search_path. The same
-- trigger therefore renders as "EXECUTE FUNCTION food_no_hard_delete()" for one
-- session and "EXECUTE FUNCTION public.food_no_hard_delete()" for another, and
-- the pretty flag and major-version deparse drift move it further. No expected
-- string could be written reliably from the migration, so comparing it would
-- either fail spuriously or have to be captured from a database - which is the
-- very thing this file refuses to do. The presence or absence of a WHEN clause
-- is the part that is both reliable and load-bearing.
-- On a mismatch, read the offending condition with
--   SELECT tgname, pg_get_expr(tgqual, tgrelid) FROM pg_trigger WHERE tgqual IS NOT NULL;
exp_trg(sig) AS (VALUES
 ('food_orders|food_orders_no_delete|11|O|no_when|food_no_hard_delete'),
 ('food_meals|food_meals_no_delete|11|O|no_when|food_no_hard_delete'),
 ('food_order_events|food_events_no_delete|27|O|no_when|food_no_hard_delete'),
 ('food_audit|food_audit_no_delete|27|O|no_when|food_no_hard_delete')),

act_trg(sig) AS (
  SELECT c.relname || '|' || g.tgname || '|' || g.tgtype::int::text
         || '|' || g.tgenabled
         || '|' || CASE WHEN g.tgqual IS NULL THEN 'no_when' ELSE 'HAS_WHEN' END
         || '|' || p.proname
    FROM pg_trigger g
    JOIN pg_class c ON c.oid = g.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = g.tgfoid
    JOIN m1_tables ON m1_tables.t = c.relname
   WHERE n.nspname = 'public' AND NOT g.tgisinternal),

d_trg AS (
  SELECT sig AS item, COALESCE(e.n,0) AS exp_n, COALESCE(a.n,0) AS act_n
    FROM (SELECT sig, count(*) AS n FROM exp_trg GROUP BY sig) e
    FULL OUTER JOIN (SELECT sig, count(*) AS n FROM act_trg GROUP BY sig) a USING (sig)
   WHERE COALESCE(e.n,0) <> COALESCE(a.n,0)),

-- ─────────────── V2.10 inbound-FK regression (leaf property) ──────────────
-- Nothing outside the food set may depend on it. Measured 0 at authoring time;
-- a non-zero value means some later migration coupled another subsystem to the
-- food tables, which changes every assumption about decommissioning.
d_inbound AS (
  SELECT src.relname || '.' || k.conname || ' -> ' || ref.relname AS item
    FROM pg_constraint k
    JOIN pg_class ref ON ref.oid = k.confrelid
    JOIN pg_class src ON src.oid = k.conrelid
    JOIN m1_tables ON m1_tables.t = ref.relname
   WHERE k.contype = 'f' AND src.relname NOT IN (SELECT t FROM m1_tables))

-- ──────────────────────────────── report ──────────────────────────────────
SELECT 'V2.1 columns' AS section,
       CASE WHEN exp_n = 0 THEN 'UNEXPECTED' WHEN act_n = 0 THEN 'MISSING'
            ELSE 'COUNT MISMATCH (' || exp_n || ' expected, ' || act_n || ' found)' END AS verdict,
       item AS detail
  FROM d_col
UNION ALL SELECT 'V2.1 columns', 'PASS', '97 M1 columns match (food_exceptions has 7, not 8 - resolution_reason is M4''s)'
  WHERE NOT EXISTS (SELECT 1 FROM d_col)

UNION ALL
SELECT 'V2.2 check constraints',
       CASE WHEN exp_n = 0 THEN 'UNEXPECTED' WHEN act_n = 0 THEN 'MISSING'
            ELSE 'COUNT MISMATCH (' || exp_n || ' expected, ' || act_n || ' found)' END,
       item FROM d_chk
UNION ALL SELECT 'V2.2 check constraints', 'PASS', '20 CHECK constraints match, compared by definition not by generated name'
  WHERE NOT EXISTS (SELECT 1 FROM d_chk)

UNION ALL
SELECT 'V2.3 foreign keys',
       CASE WHEN exp_n = 0 THEN 'UNEXPECTED' WHEN act_n = 0 THEN 'MISSING'
            ELSE 'COUNT MISMATCH (' || exp_n || ' expected, ' || act_n || ' found)' END,
       item FROM d_fk
UNION ALL SELECT 'V2.3 foreign keys', 'FAIL - NOT VALIDATED', item FROM d_fk_unvalidated
UNION ALL SELECT 'V2.3 foreign keys',
       CASE WHEN (SELECT n FROM schema_present) = 0 THEN 'NOT APPLICABLE'
            WHEN cascades = 1 AND no_action = 19   THEN 'PASS'
            ELSE 'FAIL' END,
       CASE WHEN (SELECT n FROM schema_present) = 0
            THEN 'referential actions not evaluated - no food table exists'
            ELSE 'referential actions: ' || cascades || ' ON DELETE CASCADE (expect 1), '
                   || no_action || ' NO ACTION on both delete and update (expect 19)' END
  FROM d_fk_cascade
UNION ALL SELECT 'V2.3 foreign keys', 'PASS', '20 foreign keys match: 11 to public.profiles, 9 internal to the food set'
  WHERE NOT EXISTS (SELECT 1 FROM d_fk) AND NOT EXISTS (SELECT 1 FROM d_fk_unvalidated)

UNION ALL
SELECT 'V2.4 indexes',
       CASE WHEN exp_n = 0 THEN 'UNEXPECTED' WHEN act_n = 0 THEN 'MISSING'
            ELSE 'COUNT MISMATCH (' || exp_n || ' expected, ' || act_n || ' found)' END,
       item FROM d_idx
UNION ALL SELECT 'V2.4 indexes', 'PASS', '25 index definitions match, including every partial predicate'
  WHERE NOT EXISTS (SELECT 1 FROM d_idx)

UNION ALL
SELECT 'V2.5 rls', problem, item FROM d_rls
UNION ALL SELECT 'V2.5 rls', 'PASS', 'all 11 tables: RLS enabled, NOT forced'
  WHERE NOT EXISTS (SELECT 1 FROM d_rls)

UNION ALL
SELECT 'V2.6 policy shape',
       CASE WHEN exp_n = 0 THEN 'UNEXPECTED' WHEN act_n = 0 THEN 'MISSING'
            ELSE 'COUNT MISMATCH (' || exp_n || ' expected, ' || act_n || ' found)' END,
       item FROM d_pol
UNION ALL SELECT 'V2.6 policy shape', 'PASS',
       '16 policies, correct table/command/roles, all PERMISSIVE; 6 tables carry no write policy'
  WHERE NOT EXISTS (SELECT 1 FROM d_pol)

UNION ALL
SELECT 'V2.6b policy expressions', 'PENDING',
       'Expression text NOT compared. Baseline must be captured from a FRESH M1-ONLY install (part 3, query A) and reviewed against migration lines 225-265 before acceptance.'

UNION ALL
SELECT 'V2.7 table acls', problem, item FROM d_acl
UNION ALL SELECT 'V2.7 table acls', 'PASS', 'all 11 tables: anon absent, authenticated SELECT-only, service_role full'
  WHERE NOT EXISTS (SELECT 1 FROM d_acl)

UNION ALL
SELECT 'V2.8 functions',
       CASE WHEN exp_n = 0 THEN 'UNEXPECTED SIGNATURE (overload or stray function)'
            WHEN act_n = 0 THEN 'MISSING'
            ELSE 'COUNT MISMATCH (' || exp_n || ' expected, ' || act_n || ' found)' END,
       item FROM d_fn_set
UNION ALL SELECT 'V2.8 functions', problem, item FROM d_fn_attr
UNION ALL SELECT 'V2.8 functions', 'FAIL - EXECUTE privilege', item FROM d_fn_acl
UNION ALL SELECT 'V2.8 functions', 'PASS',
       'exactly 3 signatures, no overloads; DEFINER/INVOKER, volatility, return type, search_path and the three EXECUTE invariants all hold'
  WHERE NOT EXISTS (SELECT 1 FROM d_fn_set)
    AND NOT EXISTS (SELECT 1 FROM d_fn_attr)
    AND NOT EXISTS (SELECT 1 FROM d_fn_acl)

UNION ALL
SELECT 'V2.8b function bodies', 'PENDING',
       'Bodies NOT compared. Baseline must be captured from a FRESH M1-ONLY install (part 3, query B) and reviewed against migration lines 188-203 and 300-302 before acceptance.'

UNION ALL
SELECT 'V2.9 triggers',
       CASE WHEN exp_n = 0 THEN 'UNEXPECTED' WHEN act_n = 0 THEN 'MISSING'
            ELSE 'COUNT MISMATCH (' || exp_n || ' expected, ' || act_n || ' found)' END,
       item FROM d_trg
UNION ALL SELECT 'V2.9 triggers', 'PASS',
       '4 triggers: correct events (11/11/27/27), enabled, no WHEN clause, all calling food_no_hard_delete'
  WHERE NOT EXISTS (SELECT 1 FROM d_trg)

UNION ALL
SELECT 'V2.10 inbound fks', 'FAIL - non-food table depends on the food set', item FROM d_inbound
-- Three-way, because "no inbound FK was found" means different things at
-- different levels of completeness. With 1-10 of the 11 tables present, an
-- absent inbound FK may simply be an FK to a table that does not exist yet, so
-- the leaf property has NOT been established - an earlier version reported
-- PASS for any count above zero, which made a 1-of-11 install look verified.
-- This is the leaf-property result only; it is deliberately separate from
-- V2.0 OVERALL, which still reports FAIL for a partial schema via the
-- table-by-table MISSING rows (untouched).
UNION ALL SELECT 'V2.10 inbound fks',
       CASE WHEN (SELECT n FROM schema_present) = 0  THEN 'NOT APPLICABLE'
            WHEN (SELECT n FROM schema_present) < 11 THEN 'PARTIAL - NOT VERIFIED'
            ELSE 'PASS' END,
       CASE WHEN (SELECT n FROM schema_present) = 0
            THEN 'no food table exists, so the leaf property is vacuous and was NOT verified'
            WHEN (SELECT n FROM schema_present) < 11
            THEN 'only ' || (SELECT n FROM schema_present) || ' of 11 food tables exist; '
                 || 'no inbound FK was found, but the leaf property cannot be established '
                 || 'on an incomplete schema. NOT A PASS.'
            ELSE 'all 11 food tables present and no non-food table references any of them '
                 || '(leaf property holds)' END
  WHERE NOT EXISTS (SELECT 1 FROM d_inbound)

UNION ALL
SELECT 'V2.11 coordinator', 'PENDING - RUN PART 2',
       'Reads a food table, so it is guarded and run separately. Not evaluated by this statement. A ROW COUNT IS NOT PROOF.'

-- ─────────────────────────── V2.0 OVERALL verdict ─────────────────────────
-- Precedence FAIL > PENDING > PASS, and part 1 can never reach PASS: V2.6b,
-- V2.8b and V2.11 are required and are all outside this statement.
UNION ALL
SELECT 'V2.0 OVERALL',
       CASE
         -- Checked first: on an empty target every d_* CTE is full of MISSING
         -- rows, and "FAIL" without this would be read as schema drift.
         WHEN (SELECT n FROM schema_present) = 0
           THEN 'FAIL - no food table exists; nothing was verified.'
         WHEN EXISTS (SELECT 1 FROM d_col)  OR EXISTS (SELECT 1 FROM d_chk)
           OR EXISTS (SELECT 1 FROM d_fk)   OR EXISTS (SELECT 1 FROM d_fk_unvalidated)
           OR EXISTS (SELECT 1 FROM d_idx)  OR EXISTS (SELECT 1 FROM d_rls)
           OR EXISTS (SELECT 1 FROM d_pol)  OR EXISTS (SELECT 1 FROM d_acl)
           OR EXISTS (SELECT 1 FROM d_fn_set) OR EXISTS (SELECT 1 FROM d_fn_attr)
           OR EXISTS (SELECT 1 FROM d_fn_acl) OR EXISTS (SELECT 1 FROM d_trg)
           OR EXISTS (SELECT 1 FROM d_inbound)
           OR ((SELECT n FROM schema_present) > 0
               AND NOT EXISTS (SELECT 1 FROM d_fk_cascade WHERE cascades = 1 AND no_action = 19))
           THEN 'FAIL'
         ELSE 'PENDING'
       END,
       CASE
         WHEN (SELECT n FROM schema_present) = 0
           THEN 'Run V1_triage.sql instead; V2 verifies an installed schema.'
         ELSE 'Structural checks in this statement: see the rows above. STILL REQUIRED AND NOT EVALUATED HERE: '
                || 'V2.6b (16 policy expressions), V2.8b (3 function bodies), V2.11 (coordinator identity, part 2). '
                || 'A full PASS requires all three, and the part 3 baselines must be captured from a fresh '
                || 'M1-ONLY install AND reviewed first. PENDING is not a pass.'
       END

ORDER BY 1, 2, 3;


-- ============================================================================
-- PART 2 — V2.11 seeded coordinator identity.
--
-- Run only after part 1 reports V2.1 PASS. Guarded with dynamic SQL so a
-- missing table reports MISSING instead of raising 42P01.
--
-- A ROW COUNT IS NOT PROOF. The seed's ON CONFLICT DO NOTHING has no conflict
-- target, and the only eligible unique index is the partial
-- food_one_active_coordinator ON ((true)) WHERE revoked_at IS NULL AND
-- access_level = 'active'. On a database that already holds ANY active
-- coordinator the seed is silently suppressed, leaving exactly one active row
-- belonging to the WRONG person. The holder's identity must be asserted.
--
-- THE EXPECTED UUID IS DELIBERATELY NOT DEFAULTED. It differs per environment,
-- and defaulting it would substitute one identity for another. Set it to the
-- UUID that the TARGET environment's seed was verified against, after
-- confirming that profile exists in that database and is the person intended
-- to hold the seat. Never fabricate a profile for the production CFO UUID in a
-- test database.
--
-- OBSERVABILITY - READ THIS BEFORE RELYING ON PART 2.
--   Part 2A below is a DO block. It emits RAISE NOTICE and returns NO ROWS.
--   psql shows notices; some clients (including HTTP/MCP-style SQL runners)
--   discard them, and part 2A would then appear to run and say nothing.
--   A check whose result you did not see has NOT passed. If you cannot see
--   2A's notices, run part 2B instead, which returns an ordinary result set.
--   2B references the table statically, so on a database without it the
--   statement raises 42P01 - an unambiguous MISSING signal, never a silent
--   pass. Run 2A or 2B; running neither leaves V2.11 PENDING.
-- ============================================================================

-- ─── PART 2A — guarded, NOTICE output, safe when the table is absent ───────
DO $v211$
DECLARE
  -- >>> SET THIS BEFORE RUNNING. There is intentionally no default. <<<
  v_expected uuid := NULL;

  v_total int; v_active int; v_holder uuid; v_assigned_by uuid; v_reason text;
BEGIN
  IF to_regclass('public.food_coordinator_assignments') IS NULL THEN
    RAISE NOTICE 'V2.11 MISSING - public.food_coordinator_assignments does not exist.';
    RETURN;
  END IF;

  EXECUTE $q$
    SELECT (SELECT count(*) FROM public.food_coordinator_assignments),
           (SELECT count(*) FROM public.food_coordinator_assignments
             WHERE revoked_at IS NULL AND access_level = 'active'),
           (SELECT coordinator_id FROM public.food_coordinator_assignments
             WHERE revoked_at IS NULL AND access_level = 'active'),
           (SELECT assigned_by FROM public.food_coordinator_assignments
             WHERE revoked_at IS NULL AND access_level = 'active'),
           (SELECT reason FROM public.food_coordinator_assignments
             WHERE revoked_at IS NULL AND access_level = 'active')
  $q$ INTO v_total, v_active, v_holder, v_assigned_by, v_reason;

  RAISE NOTICE 'V2.11 observed: total_rows=%, active_rows=%, holder=%, assigned_by=%, reason=%',
    v_total, v_active, COALESCE(v_holder::text,'(none)'),
    COALESCE(v_assigned_by::text,'(none)'), COALESCE(v_reason,'(none)');

  IF v_expected IS NULL THEN
    RAISE NOTICE 'V2.11 PENDING - expected coordinator UUID not set. Edit v_expected above. NOT A PASS.';
    RETURN;
  END IF;

  IF v_total <> 1 THEN
    RAISE NOTICE 'V2.11 FAIL - expected exactly 1 assignment row, found %.', v_total;
  ELSIF v_active <> 1 THEN
    RAISE NOTICE 'V2.11 FAIL - expected exactly 1 ACTIVE assignment, found %.', v_active;
  ELSIF v_holder IS DISTINCT FROM v_expected THEN
    RAISE NOTICE 'V2.11 FAIL - the active coordinator is %, not the expected %. The seed was silently suppressed by an incumbent.',
      v_holder, v_expected;
  ELSIF v_reason IS DISTINCT FROM 'Initial Food Coordinator appointment' THEN
    RAISE NOTICE 'V2.11 FAIL - reason is "%", expected "Initial Food Coordinator appointment".', v_reason;
  ELSE
    RAISE NOTICE 'V2.11 PASS - exactly one active coordinator, and it is the expected identity.';
  END IF;
END $v211$;


-- ─── PART 2B — same check, as a RESULT SET, for clients that drop notices ──
-- Run this INSTEAD OF 2A when you cannot see notices. It references the table
-- statically on purpose: if the table is absent the statement raises 42P01,
-- which is an unambiguous MISSING result rather than a quiet pass.
-- Edit the one literal in `params`, exactly as in 2A. No default is supplied.
WITH params(expected_coordinator_id) AS (
  -- >>> EDIT THIS LINE. NULL on purpose; no production identity is embedded. <<<
  SELECT NULL::uuid),
obs AS (
  SELECT count(*)::int AS total_rows,
         count(*) FILTER (WHERE revoked_at IS NULL AND access_level = 'active')::int AS active_rows,
         min(coordinator_id) FILTER (WHERE revoked_at IS NULL AND access_level = 'active') AS holder,
         min(assigned_by)    FILTER (WHERE revoked_at IS NULL AND access_level = 'active') AS assigned_by,
         min(reason)         FILTER (WHERE revoked_at IS NULL AND access_level = 'active') AS reason
    FROM public.food_coordinator_assignments)
SELECT 'V2.11 coordinator' AS section,
       CASE
         WHEN (SELECT expected_coordinator_id FROM params) IS NULL
           THEN 'PENDING - expected identity not supplied (edit the params CTE). NOT A PASS.'
         WHEN o.total_rows <> 1
           THEN 'FAIL - expected exactly 1 assignment row, found ' || o.total_rows
         WHEN o.active_rows <> 1
           THEN 'FAIL - expected exactly 1 ACTIVE assignment, found ' || o.active_rows
         WHEN o.holder IS DISTINCT FROM (SELECT expected_coordinator_id FROM params)
           THEN 'FAIL - the active coordinator is not the expected identity; the seed was silently suppressed by an incumbent'
         WHEN o.reason IS DISTINCT FROM 'Initial Food Coordinator appointment'
           THEN 'FAIL - reason is ' || COALESCE('"' || o.reason || '"', 'NULL')
                  || ', expected "Initial Food Coordinator appointment"'
         ELSE 'PASS - exactly one active coordinator, and it is the expected identity'
       END AS verdict,
       'observed: total_rows=' || o.total_rows || ', active_rows=' || o.active_rows
         || ', holder=' || COALESCE(o.holder::text, '(none)')
         || ', assigned_by=' || COALESCE(o.assigned_by::text, '(none)')
         || ', reason=' || COALESCE(o.reason, '(none)') AS detail
  FROM obs o;


-- ============================================================================
-- PART 3 — BASELINE CAPTURE. Output only; nothing is compared.
--
-- DO NOT run these against the contaminated sandbox 73ddf668 and call the
-- result a baseline. Capture from a successful FRESH M1-ONLY install during the
-- separately authorised disposable-project test.
--
-- ACCEPTANCE PROCEDURE (all four steps, in order):
--   1. Run query A and query B against the fresh M1-only install.
--   2. A reviewer reads all 16 expressions against migration lines 225-265 and
--      all 3 bodies against lines 188-203 and 300-302.
--   3. The reviewer confirms, explicitly:
--        - all 16 rows read PERMISSIVE in query A's permissive_mode column.
--          A RESTRICTIVE policy leaves every other captured field - cmd,
--          roles, qual, with_check - byte-identical, so this column is the
--          only thing in the capture that can expose the flip, and the
--          semantics invert (restrictive policies are ANDed, not ORed).
--        - EIGHT of the eleven read policies call is_food_coordinator:
--          food_meals_read, food_menu_read, food_orders_read, food_items_read,
--          food_events_read, food_exc_read, food_audit_read, food_coord_read.
--          The other THREE call no coordinator function AT ALL, by design, and
--          that is CORRECT - they gate on the row's own state:
--            food_cat_read      USING (archived_at IS NULL)
--            food_periods_read  USING (active)
--            food_closures_read USING (true)
--          These three are deliberately readable by any authenticated
--          employee: the category list, the service periods and the closure
--          calendar are not confidential. DO NOT "fix" them by adding a
--          coordinator check. M1 does not define one, adding one would hide
--          the menu's scaffolding from every ordinary employee, and a
--          coordinator call appearing in any of the three is itself a DEFECT
--          to report, not an improvement.
--        - the 5 write policies call is_active_food_coordinator in BOTH qual
--          and with_check  (a swap to is_food_coordinator silently grants the
--          BACKUP coordinator write access)
--        - the only policy whose qual is `true` is food_closures_read
--        - food_orders_read / food_items_read / food_events_read each scope to
--          auth.uid() as well as to the coordinator
--        - both permission functions read food_coordinator_assignments and
--          nothing else, and is_active_food_coordinator additionally requires
--          access_level = 'active'
--   4. Only then is the output frozen as docs/food-m1-baseline.txt and the
--      PENDING markers in part 1 replaced by real comparisons.
--
-- An unreviewed capture is not a baseline.
-- ============================================================================

-- ============================================================================
-- APPENDIX — THE SYNTHETIC-IDENTITY TEST COPY. The copy exists, at
--    supabase/tests/food_m1/fixtures/. These rules are the standard for it
--    and govern any regeneration of it. They are NOT a record of compliance:
--    rule 3 is unmet, as noted there.
--
-- M1's seed hardcodes a production coordinator UUID, so the shipping file can
-- only complete where that production profile exists. To exercise a clean
-- install in a disposable project, a TEST COPY with a synthetic identity is
-- needed. These rules apply to it.
--
-- 1. LOCATION AND NAME. The copy MUST NOT live in supabase/migrations/.
--    Anything in that directory is read as a real migration by a human eye
--    and by the repo's own conventions. It lives under
--    supabase/tests/food_m1/fixtures/, and it is named for the shipping
--    migration with a .test.sql suffix:
--      20261009120001_food_service_schema_and_coordinator.test.sql
--    THAT FILE IS A TEST FIXTURE, NOT THE SHIPPING MIGRATION. The two names
--    differ only by the .test.sql suffix and the fixtures/ directory, which
--    makes the pairing obvious but also makes them easy to confuse. Never
--    drop the suffix, never move the copy into supabase/migrations/, and
--    never let it replace the shipping migration.
-- 2. IT NEVER REPLACES THE SHIPPING MIGRATION. The original
--    supabase/migrations/20261009120001_food_service_schema_and_coordinator.sql
--    is not edited, moved, renamed or regenerated from the copy. The copy is
--    throwaway and is not applied to any environment but the disposable one.
--    An edit made to the shipping file for its own reasons - the SEC-01a
--    comment change, say - is a separate matter and is not covered here.
-- 3. THE DIFF IS RECORDED IN FULL, so the reviewer can see that the copy
--    differs from the shipping file in the identity and in nothing else.
--    STATUS: NOT MET. No fixture-vs-shipping diff record exists in this
--    repository. Nothing here should be read as evidence that one was made.
-- 4. EVERY occurrence of the production UUID must be accounted for.
--    HISTORY: before SEC-01a the shipping migration carried THREE. Line 315
--    was a comment naming the person, the UUID and a PHONE NUMBER; lines 320
--    and 321 were the seed literals. That comment is why the fixture's line
--    315 had to be REPLACED rather than copied - carrying it over would have
--    duplicated a real person's name and phone number into another file.
--    CURRENT: SEC-01a replaced lines 313-315 of the shipping file with
--    neutral wording. It now carries TWO occurrences, both executable: the
--    line 320 coordinator_id literal and the line 321 assigned_by literal.
--    No name and no phone number remain in it. The rule is unchanged - copy
--    NO personal information, and no production UUID, into the test copy.
-- 5. THE SHIPPING FILE'S OWN SEED VALUE is verified separately, against the
--    real target's public.profiles, before any real installation. Testing the
--    copy does not test that literal.
-- ============================================================================

-- Query A — V2.6b policy expressions (expect 16 rows).
-- Output columns, in order:
--   tablename, policyname, cmd, permissive_mode, roles, qual, with_check
-- permissive_mode is pg_policies.permissive, text, 'PERMISSIVE' or
-- 'RESTRICTIVE'. It is captured here - in the same position as in V2.6's
-- signature - so the frozen baseline records the mode rather than leaving it
-- visible only to V2.6's live comparison. All 16 must read PERMISSIVE; a
-- RESTRICTIVE policy leaves qual and with_check byte-identical, so the mode is
-- the only field in this capture that can reveal the flip.
SELECT tablename, policyname, cmd,
       permissive AS permissive_mode,
       roles::text AS roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('food_categories','food_meals','food_service_periods',
                     'food_service_closures','food_menu_items','food_orders',
                     'food_order_items','food_order_events','food_exceptions',
                     'food_audit','food_coordinator_assignments')
 ORDER BY tablename, policyname;

-- Query B — V2.8b function bodies and full ACLs (expect 3 rows).
-- The ACL column is for REVIEW, not comparison: the service_role entry and
-- food_no_hard_delete's PUBLIC/anon entries come from Supabase default
-- privileges rather than from M1, so they are environmental, not contractual.
-- The contractual parts are already hard-checked in part 1 (V2.8).
SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
       p.prosecdef AS security_definer,
       p.provolatile AS volatility,
       array_to_string(p.proconfig, ',') AS config,
       COALESCE((SELECT array_to_string(array_agg(x::text ORDER BY x::text), ' | ')
                   FROM unnest(p.proacl) x), '(null acl - platform defaults)') AS acl_for_review,
       pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('is_food_coordinator','is_active_food_coordinator','food_no_hard_delete')
 ORDER BY 1;
