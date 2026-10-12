-- ============================================================================
-- V1 — Food M1 target triage.
--
-- READ-ONLY. No DDL, no DML, no row is ever written. Two statements:
--
--   STATEMENT 1 (section A-E below) is CATALOG-ONLY. It reads pg_catalog and
--     nothing else - not public.profiles, not a food table - so it runs
--     unchanged on a completely empty database and always returns rows.
--   STATEMENT 2 (at the foot of this file) is the coordinator-profile
--     precondition. It is the ONLY place V1 reads an application table, it is
--     a separate statement so it cannot abort statement 1, and if
--     public.profiles does not exist it raises 42P01 - a loud, unambiguous
--     MISSING result, never a silent pass.
--
--   An earlier version of this file put the public.profiles read inside
--   statement 1. PostgreSQL resolves table references at PARSE time, before
--   any CASE branch is evaluated, so on a database without public.profiles the
--   whole statement raised 42P01 and printed nothing at all - which made the
--   very check that reports "public.profiles is absent" unreachable in the one
--   case it existed for. Hence the split. Do not move the profiles read back
--   into statement 1.
--
-- M1-ONLY VERIFIER. The expectations below describe
--   supabase/migrations/20261009120000_food_service_schema_and_coordinator.sql
-- and NOTHING ELSE. A database carrying M2 (…130000 operations RPCs), M3
-- (…160000 coordinator candidates) or M4 (…170000 exception resolution) will
-- NOT match: M4 adds food_exceptions.resolution_reason (98 columns, not 97) and
-- M2-M4 add 20 further functions. Against such a database this script still
-- reports IDENTITIES COMPLETE - it only inspects M1's three function
-- signatures - while V2 correctly fails on the extra column. That is intended.
-- Do not use either script to verify a stacked M1-M4 installation.
--
-- WHAT V1 ESTABLISHES
--   Whether every NAME M1 creates is free, or every object is present under
--   the expected identity; whether anything unexpected sits on the eleven
--   tables; and whether ten hard invariants hold.
--
-- WHAT V1 CANNOT ESTABLISH
--   That a present object is DEFINED correctly. A table with the right name
--   and the wrong columns, a policy whose USING became `true`, a trigger that
--   lost its UPDATE event - all read as PRESENT here. "IDENTITIES COMPLETE" is
--   NOT a statement of correctness. Run V2_verify.sql for that.
--   Neither script proves behaviour: no SQL here shows that food_orders_read
--   actually hides another employee's order under a real JWT, nor that the
--   no-delete triggers actually refuse a delete.
--
-- HOW TO RUN
--   psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f V1_triage.sql
--   Free of psql meta-commands, and each statement returns one result set, so
--   both also work in a client that returns only the last result set - run
--   them separately there.
--
-- THE ONE PARAMETER — EDIT IT BEFORE RUNNING
--   The expected Food Coordinator UUID is supplied by EDITING THE LITERAL in
--   the `params` CTE of EACH statement (search for "EDIT THIS LINE"). It is
--   NULL by default and no production identity is baked in.
--
--   It is an edited literal and not a bind parameter on purpose: this file has
--   no psql meta-commands, so :'var' would tie it to psql and $1 would need a
--   client that binds parameters. Neither is something the script can provide.
--
--   Leaving it unset is safe. Statement 1 reports PENDING and can never reach
--   PASS; statement 2 reports PENDING too. It is never silently skipped, and
--   no real identity is substituted for it.
--
-- SUPABASE ROLES
--   The ACL invariants name the roles anon, authenticated and service_role.
--   On a database where those roles do not exist, row c00 reports it and the
--   ACL invariants become meaningless - read c00 before trusting b13/b14/b18.
--
-- VERSION SENSITIVITY
--   Authored against PostgreSQL 17.x. The 16 implicit index names below are
--   PostgreSQL's generated names; they are deterministic, and the longest
--   (food_menu_items_service_date_period_id_meal_id_key, 50 chars) is well
--   inside the 63-character identifier limit, so no truncation applies.
-- ============================================================================


-- ============================================================================
-- STATEMENT 1 — catalog-only triage. Safe on any database, including empty.
-- Read row "A. OVERALL" first; it is deliberately the first row returned.
-- ============================================================================

WITH tbl(t) AS (VALUES
  ('food_categories'),('food_meals'),('food_service_periods'),('food_service_closures'),
  ('food_menu_items'),('food_orders'),('food_order_items'),('food_order_events'),
  ('food_exceptions'),('food_audit'),('food_coordinator_assignments')),

params(expected_coordinator_id) AS (
  -- >>> EDIT THIS LINE before running. NULL on purpose: there is no default,
  -- >>> and no production identity is embedded in this file. Set it to the
  -- >>> UUID this TARGET environment's seed is meant to appoint, after
  -- >>> confirming that profile exists there and is the intended holder.
  SELECT NULL::uuid),

-- ─────────────────────── expected object identities ───────────────────────
-- 11 tables + 25 indexes + 16 policies + 4 triggers + 3 functions = 59
expected(kind, identity) AS (VALUES
  ('table','food_categories'),('table','food_meals'),('table','food_service_periods'),
  ('table','food_service_closures'),('table','food_menu_items'),('table','food_orders'),
  ('table','food_order_items'),('table','food_order_events'),('table','food_exceptions'),
  ('table','food_audit'),('table','food_coordinator_assignments'),

  -- 9 explicit indexes
  ('index','food_meals_status_idx'),('index','food_menu_items_day_idx'),
  ('index','food_orders_employee_idx'),('index','food_orders_queue_idx'),
  ('index','food_order_items_order_idx'),('index','food_order_events_order_idx'),
  ('index','food_audit_entity_idx'),('index','food_one_active_coordinator'),
  ('index','food_coordinator_lookup'),
  -- 16 implicit indexes (PRIMARY KEY / UNIQUE)
  ('index','food_audit_pkey'),('index','food_categories_pkey'),
  ('index','food_categories_name_key'),('index','food_coordinator_assignments_pkey'),
  ('index','food_exceptions_pkey'),('index','food_meals_pkey'),
  ('index','food_menu_items_pkey'),
  ('index','food_menu_items_service_date_period_id_meal_id_key'),
  ('index','food_order_events_pkey'),('index','food_order_items_pkey'),
  ('index','food_orders_idempotency_key_key'),('index','food_orders_order_reference_key'),
  ('index','food_orders_pkey'),('index','food_service_closures_pkey'),
  ('index','food_service_periods_pkey'),('index','food_service_periods_name_key'),

  -- 16 policies, keyed table|policy
  ('policy','food_categories|food_cat_read'),
  ('policy','food_service_periods|food_periods_read'),
  ('policy','food_service_closures|food_closures_read'),
  ('policy','food_meals|food_meals_read'),
  ('policy','food_menu_items|food_menu_read'),
  ('policy','food_orders|food_orders_read'),
  ('policy','food_order_items|food_items_read'),
  ('policy','food_order_events|food_events_read'),
  ('policy','food_exceptions|food_exc_read'),
  ('policy','food_audit|food_audit_read'),
  ('policy','food_coordinator_assignments|food_coord_read'),
  ('policy','food_categories|food_cat_write'),
  ('policy','food_meals|food_meals_write'),
  ('policy','food_service_periods|food_per_write'),
  ('policy','food_service_closures|food_clo_write'),
  ('policy','food_menu_items|food_menu_write'),

  -- 4 triggers, keyed table|trigger
  ('trigger','food_orders|food_orders_no_delete'),
  ('trigger','food_meals|food_meals_no_delete'),
  ('trigger','food_order_events|food_events_no_delete'),
  ('trigger','food_audit|food_audit_no_delete'),

  -- 3 functions, keyed by IDENTITY ARGUMENTS so an overload shows as UNEXPECTED
  ('function','is_food_coordinator(uuid)'),
  ('function','is_active_food_coordinator(uuid)'),
  ('function','food_no_hard_delete()')),

actual(kind, identity) AS (
  -- NO relkind filter here, deliberately. The question this branch answers is
  -- "is the NAME taken", not "is there a table". CREATE TABLE public.X (which
  -- M1 issues without IF NOT EXISTS) collides with ANY entry in pg_class in
  -- the schema - a view, materialised view, sequence, foreign table,
  -- partitioned table or index - and raises 42P07. Filtering to relkind='r'
  -- would report such a name as ABSENT and let the verdict read clean on a
  -- database where the migration is certain to fail. Invariant b16 then names
  -- anything present that is not an ordinary table.
  -- The relkind='r' filters further down are a different question (they assert
  -- table-specific properties) and are correct as they stand.
  SELECT 'table', c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN tbl ON tbl.t = c.relname
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'index', i.indexname
    FROM pg_indexes i JOIN tbl ON tbl.t = i.tablename
   WHERE i.schemaname = 'public'
  UNION ALL
  SELECT 'policy', p.tablename || '|' || p.policyname
    FROM pg_policies p JOIN tbl ON tbl.t = p.tablename
   WHERE p.schemaname = 'public'
  UNION ALL
  SELECT 'trigger', c.relname || '|' || g.tgname
    FROM pg_trigger g
    JOIN pg_class c ON c.oid = g.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN tbl ON tbl.t = c.relname
   WHERE n.nspname = 'public' AND NOT g.tgisinternal
  UNION ALL
  SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('is_food_coordinator','is_active_food_coordinator','food_no_hard_delete')),

-- Counted reconciliation rather than bare existence. NOTE: with the keys used
-- here (relname per schema, indexname, table+policyname, table+tgname,
-- function identity signature) the catalog itself enforces uniqueness, so the
-- DUPLICATED state is not reachable in practice. It is retained as a cheap
-- invariant assertion, not as working duplicate protection - do not cite it as
-- duplicate protection.
recon AS (
  SELECT kind, identity,
         CASE WHEN COALESCE(a.n,0) = 0 THEN 'ABSENT'
              WHEN COALESCE(e.n,0) = 0 THEN 'UNEXPECTED'
              WHEN e.n <> a.n         THEN 'DUPLICATED'
              ELSE 'PRESENT' END AS state
    FROM (SELECT kind, identity, count(*) AS n FROM expected GROUP BY 1,2) e
    FULL OUTER JOIN (SELECT kind, identity, count(*) AS n FROM actual GROUP BY 1,2) a
      USING (kind, identity)),

-- How many of the 11 names are present as ORDINARY TABLES. Distinguishes an
-- empty target (0) from a partial one (1-10) from a full one (11).
present_tables(n) AS (
  SELECT count(*)::int FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN tbl ON tbl.t = c.relname
   WHERE ns.nspname = 'public' AND c.relkind = 'r'),

-- ══════════════════════════════ INVARIANTS ════════════════════════════════
-- Ten conditions that must hold at ZERO on a clean target and on an installed
-- one alike. Every one of these feeds the OVERALL verdict - an earlier version
-- consulted only three of them, so an installed database leaking anon INSERT
-- on food_orders was reported PENDING ("run V2 next") instead of FAIL.
--
-- ACL NOTE. aclexplode emits grantee = 0 for PUBLIC, and PUBLIC has NO row in
-- pg_roles, so an INNER JOIN to pg_roles silently discards every PUBLIC grant.
-- b13 therefore LEFT JOINs and tests `ae.grantee = 0 OR r.rolname = 'anon'`.
-- An earlier version used an inner join and could not see a GRANT ... TO PUBLIC
-- at all.
--
-- NULL relacl means no explicit ACL was ever recorded; the effective
-- privileges are then PostgreSQL's built-in default for a relation - the OWNER
-- holds everything and PUBLIC holds nothing. It does NOT mean anon or
-- authenticated hold anything, so b13/b14 counting zero for such a table is
-- the correct answer to the question they ask. b15 reports the NULL ACL
-- itself; b18 reports the consequence, that M1's required grants are absent.
inv(code, label, n, detail) AS (
  SELECT 'b07', 'foreign keys not validated',
         (SELECT count(*) FROM pg_constraint k
            JOIN pg_class c ON c.oid = k.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND k.contype = 'f' AND NOT k.convalidated),
         (SELECT string_agg(c.relname || '.' || k.conname, ', ' ORDER BY k.conname)
            FROM pg_constraint k
            JOIN pg_class c ON c.oid = k.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND k.contype = 'f' AND NOT k.convalidated)
  UNION ALL
  SELECT 'b10', 'identity or generated columns (M1 has none)',
         (SELECT count(*) FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
             AND (a.attidentity <> '' OR a.attgenerated <> '')),
         (SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname)
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
             AND (a.attidentity <> '' OR a.attgenerated <> ''))
  UNION ALL
  SELECT 'b12', 'RLS FORCED (would break the SECURITY DEFINER RPCs)',
         (SELECT count(*) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity),
         (SELECT string_agg(c.relname, ', ' ORDER BY c.relname) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity)
  UNION ALL
  SELECT 'b13', 'table privileges held by anon or PUBLIC',
         (SELECT count(*) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
            CROSS JOIN LATERAL aclexplode(c.relacl) ae
            LEFT JOIN pg_roles r ON r.oid = ae.grantee
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND (ae.grantee = 0 OR r.rolname = 'anon')),
         (SELECT string_agg(DISTINCT c.relname || ':' || COALESCE(r.rolname,'PUBLIC')
                            || ':' || ae.privilege_type, ', ')
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
            CROSS JOIN LATERAL aclexplode(c.relacl) ae
            LEFT JOIN pg_roles r ON r.oid = ae.grantee
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND (ae.grantee = 0 OR r.rolname = 'anon'))
  UNION ALL
  -- M1 grants authenticated plain SELECT and nothing else. Anything other than
  -- SELECT is a violation, and so is SELECT carrying WITH GRANT OPTION
  -- (is_grantable), which would let authenticated re-grant it onward.
  SELECT 'b14', 'authenticated privileges other than plain SELECT (incl. grant option)',
         (SELECT count(*) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
            CROSS JOIN LATERAL aclexplode(c.relacl) ae
            JOIN pg_roles r ON r.oid = ae.grantee
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND r.rolname = 'authenticated'
             AND (ae.privilege_type <> 'SELECT' OR ae.is_grantable)),
         (SELECT string_agg(DISTINCT c.relname || ':' || ae.privilege_type
                            || CASE WHEN ae.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END, ', ')
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
            CROSS JOIN LATERAL aclexplode(c.relacl) ae
            JOIN pg_roles r ON r.oid = ae.grantee
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND r.rolname = 'authenticated'
             AND (ae.privilege_type <> 'SELECT' OR ae.is_grantable))
  UNION ALL
  SELECT 'b15', 'present tables whose relacl is NULL (no explicit grant recorded)',
         (SELECT count(*) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relacl IS NULL),
         (SELECT string_agg(c.relname, ', ' ORDER BY c.relname) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relacl IS NULL)
  UNION ALL
  SELECT 'b16', 'M1 names held by a NON-table relation (CREATE TABLE would raise 42P07)',
         (SELECT count(*) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind <> 'r'),
         -- relkind codes: v view, m matview, S sequence, f foreign table,
         -- p partitioned table, i index, I partitioned index, c composite type.
         (SELECT string_agg(c.relname || ' (relkind=' || c.relkind || ')', ', ' ORDER BY c.relname)
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind <> 'r')
  UNION ALL
  SELECT 'b17', 'inbound foreign keys from NON-food tables (breaks the leaf property)',
         (SELECT count(*) FROM pg_constraint k
            JOIN pg_class ref ON ref.oid = k.confrelid
            JOIN pg_class src ON src.oid = k.conrelid
            JOIN tbl ON tbl.t = ref.relname
           WHERE k.contype = 'f' AND src.relname NOT IN (SELECT t FROM tbl)),
         (SELECT string_agg(src.relname || '.' || k.conname, ', ' ORDER BY k.conname)
            FROM pg_constraint k
            JOIN pg_class ref ON ref.oid = k.confrelid
            JOIN pg_class src ON src.oid = k.conrelid
            JOIN tbl ON tbl.t = ref.relname
           WHERE k.contype = 'f' AND src.relname NOT IN (SELECT t FROM tbl))
  UNION ALL
  -- The POSITIVE grant assertion. b13/b14/b15 are all absence checks, so a
  -- non-null ACL of {postgres=arwdDxtm/postgres} - with no authenticated entry
  -- at all - would pass every one of them while authenticated cannot read.
  -- service_role DELETE stands in for M1's GRANT ALL. A full element-by-element
  -- ACL comparison is V2.7's job; this is triage.
  SELECT 'b18', 'present tables missing a required grant (authenticated SELECT, service_role ALL)',
         (SELECT count(*) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND (NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) ae
                                JOIN pg_roles r ON r.oid = ae.grantee
                               WHERE r.rolname = 'authenticated' AND ae.privilege_type = 'SELECT')
               OR NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) ae
                                JOIN pg_roles r ON r.oid = ae.grantee
                               WHERE r.rolname = 'service_role' AND ae.privilege_type = 'DELETE'))),
         (SELECT string_agg(c.relname, ', ' ORDER BY c.relname) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND (NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) ae
                                JOIN pg_roles r ON r.oid = ae.grantee
                               WHERE r.rolname = 'authenticated' AND ae.privilege_type = 'SELECT')
               OR NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) ae
                                JOIN pg_roles r ON r.oid = ae.grantee
                               WHERE r.rolname = 'service_role' AND ae.privilege_type = 'DELETE')))
  UNION ALL
  -- M1 issues no column-level GRANT, so any column ACL on a food table is
  -- something nobody wrote down. Table-level grants alone would miss it.
  SELECT 'b19', 'column-level ACLs on food tables (M1 grants none)',
         (SELECT count(*) FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL),
         (SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname)
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)),

violations AS (SELECT code, label, n, detail FROM inv WHERE n > 0),

-- ─────────────── informational counts, NOT pass/fail invariants ───────────
-- These legitimately differ between a clean target (0) and an installed one,
-- so they inform rather than decide. The deciding checks are `inv` above and
-- the identity reconciliation.
env(section, item, value) AS (
  SELECT 'C. environment', 'c00 supabase roles present (anon/authenticated/service_role)',
         (SELECT string_agg(rolname, ', ' ORDER BY rolname) FROM pg_roles
           WHERE rolname IN ('anon','authenticated','service_role'))
  UNION ALL
  -- Catalog lookup only. to_regclass returns NULL instead of raising when the
  -- relation is absent, and because statement 1 never READS public.profiles
  -- this row is genuinely reachable in both states.
  SELECT 'C. environment', 'c01 public.profiles present (prerequisite: 11 FKs)',
         (to_regclass('public.profiles') IS NOT NULL)::text
  UNION ALL
  SELECT 'C. environment', 'c02 expected coordinator UUID supplied',
         CASE WHEN (SELECT expected_coordinator_id FROM params) IS NULL
              THEN 'PENDING - not supplied (edit the params CTE)'
              ELSE 'supplied - existence is checked by STATEMENT 2, not here' END
  UNION ALL
  SELECT 'C. environment', 'c03 M1 names present as ordinary tables (0 empty / 1-10 partial / 11 full)',
         (SELECT n::text FROM present_tables)
  UNION ALL
  SELECT 'C. environment', 'c04 foreign keys on the 11 tables (expect 0 or 20)',
         (SELECT count(*)::text FROM pg_constraint k
            JOIN pg_class c ON c.oid = k.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND k.contype = 'f')
  UNION ALL
  SELECT 'C. environment', 'c05   ...referencing public.profiles (expect 0 or 11)',
         (SELECT count(*)::text FROM pg_constraint k
            JOIN pg_class c ON c.oid = k.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND k.contype = 'f'
             AND k.confrelid = to_regclass('public.profiles')::oid)
  UNION ALL
  SELECT 'C. environment', 'c06   ...internal to the food set (expect 0 or 9)',
         (SELECT count(*)::text FROM pg_constraint k
            JOIN pg_class c ON c.oid = k.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_class ref ON ref.oid = k.confrelid
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND k.contype = 'f'
             AND ref.relname IN (SELECT t FROM tbl))
  UNION ALL
  SELECT 'C. environment', 'c07   ...with ON DELETE CASCADE (expect 0 or 1)',
         (SELECT count(*)::text FROM pg_constraint k
            JOIN pg_class c ON c.oid = k.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND k.contype = 'f' AND k.confdeltype = 'c')
  UNION ALL
  SELECT 'C. environment', 'c08 CHECK constraints on the 11 tables (expect 0 or 20)',
         (SELECT count(*)::text FROM pg_constraint k
            JOIN pg_class c ON c.oid = k.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND k.contype = 'c')
  UNION ALL
  SELECT 'C. environment', 'c09 columns on the 11 tables (expect 0 or 97 - M1 ONLY)',
         (SELECT count(*)::text FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped)
  UNION ALL
  SELECT 'C. environment', 'c10 RLS enabled (expect 0 or 11)',
         (SELECT count(*)::text FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN tbl ON tbl.t = c.relname
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity))

-- ──────────────────────────────── report ──────────────────────────────────
-- A. OVERALL sorts first on purpose, so the combined verdict is the first
-- thing printed. Precedence is strictly FAIL > PENDING > PASS: an invariant
-- violation is never downgraded to PENDING because something else is
-- unresolved.
SELECT 'A. OVERALL' AS section, 'a1 verdict' AS item,
       CASE
         -- (1) FAIL: any of the ten invariants violated. Checked first.
         WHEN EXISTS (SELECT 1 FROM violations)                                 THEN 'FAIL'
         -- (2) FAIL: something unexpected or duplicated carries an M1 name.
         WHEN EXISTS (SELECT 1 FROM recon WHERE state IN ('UNEXPECTED','DUPLICATED'))
                                                                                THEN 'FAIL'
         -- (3) FAIL: half an installation. Missing expected tables are never a
         --     successful verification.
         WHEN EXISTS (SELECT 1 FROM recon WHERE state <> 'ABSENT')
          AND EXISTS (SELECT 1 FROM recon WHERE state <> 'PRESENT')             THEN 'FAIL'
         -- (4) FAIL: the hard prerequisite for 11 foreign keys is missing.
         WHEN to_regclass('public.profiles') IS NULL                            THEN 'FAIL'
         -- (5) PENDING: the identity parameter was never supplied.
         WHEN (SELECT expected_coordinator_id FROM params) IS NULL              THEN 'PENDING'
         -- (6) PENDING for every remaining state. Statement 1 can NEVER reach
         --     PASS on its own: the coordinator profile is statement 2's job,
         --     and object CORRECTNESS is V2's.
         ELSE 'PENDING'
       END,
       CASE
         WHEN EXISTS (SELECT 1 FROM violations)
           THEN 'INVARIANT VIOLATED: ' || (SELECT string_agg(code || ' ' || label, '; ' ORDER BY code)
                                             FROM violations) || '. STOP - do not install, do not proceed.'
         WHEN EXISTS (SELECT 1 FROM recon WHERE state IN ('UNEXPECTED','DUPLICATED'))
           THEN 'Unexpected or duplicated objects carry M1 names. STOP.'
         WHEN EXISTS (SELECT 1 FROM recon WHERE state <> 'ABSENT')
          AND EXISTS (SELECT 1 FROM recon WHERE state <> 'PRESENT')
           THEN 'PARTIAL installation - some M1 names present, some absent. STOP; do not retry blindly.'
         WHEN to_regclass('public.profiles') IS NULL
           THEN 'public.profiles is absent; 11 of M1''s foreign keys require it.'
         WHEN (SELECT expected_coordinator_id FROM params) IS NULL
           THEN 'Expected coordinator UUID not supplied. NOT A PASS. Edit the params CTE in BOTH statements.'
         WHEN NOT EXISTS (SELECT 1 FROM recon WHERE state <> 'ABSENT')
           THEN 'No M1 name is taken and all ten invariants hold. Statement 1 is clear. '
                || 'STILL REQUIRED: STATEMENT 2 (coordinator profile). Statement 1 alone is not a pass.'
         WHEN NOT EXISTS (SELECT 1 FROM recon WHERE state <> 'PRESENT')
           THEN 'IDENTITIES COMPLETE and all ten invariants hold - this is NOT a correctness result. '
                || 'STILL REQUIRED: STATEMENT 2, and V2_verify.sql for object definitions.'
         ELSE 'Unclassified state - treat as FAIL and investigate.'
       END

-- Every branch below returns the SAME FOUR COLUMNS: section, item, value,
-- detail. Keep it that way - a branch with three would make the whole UNION
-- invalid.
UNION ALL
SELECT 'B. identities', kind || ' [' || state || ']',
       count(*)::text,
       string_agg(identity, ', ' ORDER BY identity)
  FROM recon GROUP BY kind, state

UNION ALL SELECT section, item, value, NULL::text FROM env

UNION ALL
SELECT 'D. invariants', code || ' ' || label,
       CASE WHEN n = 0 THEN 'OK (0)' ELSE 'VIOLATED (' || n || ')' END,
       COALESCE(detail, '')
  FROM inv

UNION ALL
SELECT 'E. detail', 'e1 identity scope',
       CASE
         WHEN EXISTS (SELECT 1 FROM inv WHERE code = 'b16' AND n > 0)
           THEN 'NAME COLLISION - an M1 name is held by a non-table relation; CREATE TABLE would raise 42P07.'
         WHEN EXISTS (SELECT 1 FROM recon WHERE state IN ('UNEXPECTED','DUPLICATED'))
           THEN 'UNEXPECTED OBJECTS carry M1 names.'
         WHEN NOT EXISTS (SELECT 1 FROM recon WHERE state <> 'ABSENT')
           THEN 'NO M1 NAME TAKEN (identity scope only - says nothing about preconditions or correctness).'
         WHEN NOT EXISTS (SELECT 1 FROM recon WHERE state <> 'PRESENT')
           THEN 'IDENTITIES COMPLETE (identity scope only - NOT a correctness result; run V2_verify.sql).'
         ELSE 'PARTIAL - some M1 names present, some absent.'
       END,
       NULL::text

ORDER BY 1, 2, 3;


-- ============================================================================
-- STATEMENT 2 — coordinator-profile precondition.
--
-- The ONLY statement in V1 that reads an application table. Kept separate so
-- it cannot abort statement 1.
--
-- IF public.profiles DOES NOT EXIST this statement raises 42P01
-- (undefined_table). That is the intended, documented MISSING result - a loud
-- error, never a silent pass. Statement 1's row c01 tells you in advance
-- whether to expect it. Do not wrap this in anything that swallows the error.
--
-- It checks only that the profile EXISTS. Whether that person is the RIGHT
-- holder for this environment is a human decision, and whether they actually
-- hold the active coordinator seat is V2.11's check, not this one.
-- ============================================================================

WITH params(expected_coordinator_id) AS (
  -- >>> EDIT THIS LINE. Must match the value used in statement 1. NULL on
  -- >>> purpose; no production identity is embedded in this file.
  SELECT NULL::uuid)
SELECT 'V1 statement 2' AS section,
       CASE
         WHEN (SELECT expected_coordinator_id FROM params) IS NULL
           THEN 'PENDING - expected identity not supplied. NOT A PASS.'
         WHEN EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.id = (SELECT expected_coordinator_id FROM params))
           THEN 'PASS - the expected coordinator profile exists in this database.'
         ELSE 'FAIL - the expected coordinator profile does not exist here; '
              || 'M1''s seed INSERT would fail its foreign key.'
       END AS verdict,
       'Existence only. Whether this is the right person is a human decision; '
       || 'whether they hold the active seat is V2.11.' AS note;


-- ============================================================================
-- READING THE RESULT — V1 IS A PASS ONLY WHEN BOTH STATEMENTS AGREE
--
-- Statement 1 row A. OVERALL can only ever be FAIL or PENDING. It has no PASS
-- branch, deliberately: the coordinator profile lives in statement 2 and
-- object correctness lives in V2_verify.sql, so statement 1 alone cannot
-- establish a pass. PENDING IS NOT A PASS.
--
--   V1 is clear for a CLEAN TARGET when, and only when:
--     statement 1  A. OVERALL = PENDING, detail "No M1 name is taken and all
--                  ten invariants hold", and section D shows ten OK (0) rows
--     statement 2  PASS
--   Anything else - any FAIL, any VIOLATED row in section D, any PENDING for
--   an unsupplied parameter - is not clear.
--
-- Section D lists all ten invariants with the offending object names. Every
-- one of them feeds A. OVERALL; none can be downgraded to PENDING by an
-- unrelated unresolved check.
--
-- Section E is identity scope ONLY. "NO M1 NAME TAKEN" and "IDENTITIES
-- COMPLETE" describe names, not correctness and not preconditions. Neither is
-- a verdict - read A. OVERALL for that.
--
-- SCOPE OF THE ACL INVARIANTS. b13/b14/b18/b19 are triage, not a full ACL
-- audit: they catch anon or PUBLIC holding anything, authenticated holding
-- more than plain SELECT, a required grant missing, and any column-level ACL.
-- They do NOT compare the complete ACL element by element - a stray grant to
-- some fourth role would pass V1. That comparison is DEFERRED TO V2.7, which
-- asserts set equality against the exact expected ACL. V1 does not verify it.
--
-- Even "all clear" authorises nothing beyond ATTEMPTING an install.
-- ============================================================================
