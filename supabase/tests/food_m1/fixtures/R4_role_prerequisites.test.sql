-- Food M1 — R4 role prerequisites. TEST FIXTURE ONLY.
--
-- NOT A MIGRATION. This file lives under supabase/tests/ and must never be
-- added to supabase/migrations/ or applied to production. It exists because
-- food_transfer_coordinator (M2:596-604) gates eligibility on
--
--     profiles.deleted_at IS NULL
--     AND EXISTS (SELECT 1 FROM user_roles ur
--                  WHERE ur.user_id = p.id
--                    AND ur.role = 'employee'::public.app_role
--                    AND COALESCE(ur.enabled, true))
--
-- and the repository's migration chain cannot satisfy that predicate:
--
--   * app_role is created once (20251224121033:2) with five labels and gains
--     nine more via ALTER TYPE ... ADD VALUE. NONE of the ten statements adds
--     'employee', yet 'employee'::app_role is referenced from 20260330122249
--     onward - BEFORE the first ADD VALUE - so the chain cannot be replayed.
--   * user_roles is created (20251224121033:15-21) with id, user_id, role,
--     created_at and NO `enabled` column, though 207 migrations read it.
--   * profiles.deleted_at IS in the chain (20260821100456:70) and is handled
--     here only for completeness.
--
-- WHAT THIS DOES NOT DO. It does not copy production's enum. M1's own header
-- records that the live app_role has 25 labels; this file adds exactly one,
-- because R4's predicate needs 'employee' to be a VALID LABEL and nothing
-- more. It never drops, recreates or renames the type, and never removes or
-- reorders an existing label. The resulting enum is deliberately NOT a
-- statement about production's shape.
--
-- RERUN SAFE. Every step is IF NOT EXISTS or guarded, and the preconditions
-- are checked before anything is written.

\set ON_ERROR_STOP on

-- ═══════════════════ step 0 — refuse anything resembling real data ═══════════════════
-- Mirrors the threshold the harness already uses (MAX_TEST_DB_PROFILES = 1000
-- in src/__tests__/foodDbTestGate.ts) and the food_concurrency suite's guard.
BEGIN;

DO $guard$
DECLARE v_profiles bigint; v_roles bigint;
BEGIN
  SELECT count(*) INTO v_profiles FROM public.profiles;
  IF v_profiles >= 1000 THEN
    RAISE EXCEPTION
      'Refusing to run: public.profiles has % rows. This fixture alters shared types and tables; point it at a disposable database.',
      v_profiles;
  END IF;

  -- PRECONDITIONS, checked before any write. This fixture adds a label and a
  -- column; it deliberately does NOT create app_role or user_roles, because
  -- inventing their shape would be guessing at production.
  IF to_regtype('public.app_role') IS NULL THEN
    RAISE EXCEPTION
      'public.app_role does not exist. This fixture only ADDS the missing ''employee'' label to an existing enum; it will not create the type. Apply the baseline (20251224121033) first, or decide separately how this database should obtain app_role.';
  END IF;

  IF to_regclass('public.user_roles') IS NULL THEN
    RAISE EXCEPTION
      'public.user_roles does not exist. This fixture only ADDS the missing `enabled` column to an existing table; it will not create the table. Apply the baseline (20251224121033) first.';
  END IF;

  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'public.profiles does not exist; the Food M1 schema fixture depends on it.';
  END IF;

  -- Incompatible state: user_roles.enabled present but not boolean.
  SELECT count(*) INTO v_roles
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'user_roles'
     AND column_name = 'enabled' AND data_type <> 'boolean';
  IF v_roles > 0 THEN
    RAISE EXCEPTION
      'public.user_roles.enabled exists but is not boolean. Refusing to alter it; resolve this by hand.';
  END IF;
END $guard$;

COMMIT;

-- ═══════════════════ step 1 — the enum label, in its OWN transaction ═══════════════════
-- TRANSACTION RULE, and why this is a separate step. PostgreSQL 12+ permits
-- ALTER TYPE ... ADD VALUE inside a transaction block, but the new label
-- CANNOT BE USED until that transaction has committed. Step 2 casts to
-- 'employee', so the ALTER must commit first. Combining the two would fail
-- with "unsafe use of new value of enum type".
--
-- ADD VALUE IF NOT EXISTS is a no-op when the label is already present, which
-- is what makes this rerunnable and what makes it safe against the live enum
-- already carrying 'employee'.
BEGIN;

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'employee';

COMMIT;

-- ═══════════════════ step 2 — the columns, and verification ═══════════════════
BEGIN;

-- NULLABILITY AND DEFAULT, justified rather than chosen.
-- M2:604 reads COALESCE(ur.enabled, true): an absent value means ENABLED. A
-- NOT NULL DEFAULT true column expresses exactly that semantic for existing
-- rows, and makes the COALESCE redundant without ever changing its result.
-- It also removes a third state - NULL - that could be confused with the
-- `enabled = false` case R4 asserts on (seedRoles, R4:89-94).
--
-- This is a choice about a TEST database. It is not a claim that production's
-- column is NOT NULL; production's shape is unknown and unexamined here.
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

-- Present in the chain already (20260821100456:70); repeated only so a
-- database built from the Food M1 fixture alone is not missing it.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Verification. Casting to 'employee' here is safe: step 1 committed.
DO $verify$
DECLARE v_label_ok boolean; v_enabled_ok boolean; v_deleted_ok boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                  WHERE t.typname = 'app_role' AND e.enumlabel = 'employee')
    INTO v_label_ok;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user_roles'
                    AND column_name='enabled' AND data_type='boolean')
    INTO v_enabled_ok;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='profiles'
                    AND column_name='deleted_at')
    INTO v_deleted_ok;

  IF NOT (v_label_ok AND v_enabled_ok AND v_deleted_ok) THEN
    RAISE EXCEPTION 'R4 prerequisites incomplete: employee=% enabled=% deleted_at=%',
      v_label_ok, v_enabled_ok, v_deleted_ok;
  END IF;

  -- Proves the label is usable, not merely present. Casts only; writes nothing.
  PERFORM 'employee'::public.app_role;

  RAISE NOTICE 'R4 prerequisites satisfied. app_role now has % labels.',
    (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'app_role');
END $verify$;

COMMIT;

-- NOT DONE HERE, deliberately: no user_roles rows are inserted. R4 seeds its
-- own inside each test transaction and rolls them back (seedRoles, R4:85-98).
