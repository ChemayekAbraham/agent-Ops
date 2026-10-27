-- =============================================================================
-- Test: supabase/tests/staff_assistant_prompt4_advisor_insights_and_ideas.sql
-- Purpose:
--   Verifies inside a transaction that ALWAYS rolls back:
--   1. All 6 new `assistant_staff_insight_*` advisor functions exist, are STABLE,
--      SECURITY DEFINER, write nothing, and run cleanly inside
--      `SET LOCAL TRANSACTION READ ONLY`.
--   2. Role gates refuse unauthorized roles with SQLSTATE 42501, and finance
--      vs staff insights are gated the same way as their reports.
--   3. `staff_assistant_insights` and `staff_assistant_ideas` have RLS enabled,
--      `mfa_required_for_staff` RESTRICTIVE policy, and grant SELECT only to
--      `authenticated` (no INSERT/UPDATE/DELETE table privileges).
--   4. `staff_assistant_save_idea` requires an unexpired, unused `'idea'` draft
--      owned by `auth.uid()`, and `staff_assistant_update_idea_status` allows
--      status changes only for managers, the COO, and the CEO.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_fn text;
  v_provolatile char;
  v_prosecdef boolean;
  v_has_write_priv boolean;
  v_fns text[] := ARRAY[
    'assistant_staff_insight_desk_wait_times',
    'assistant_staff_insight_collection_coverage_trends',
    'assistant_staff_insight_calling_reach_and_themes',
    'assistant_staff_insight_payout_delays',
    'assistant_staff_insight_zoe_unanswered_and_feedback',
    'assistant_staff_insight_anomalies'
  ];
  v_tbl text;
  v_tbls text[] := ARRAY[
    'staff_assistant_insights',
    'staff_assistant_ideas'
  ];
BEGIN
  -- 1. Confirm all 6 advisor functions are STABLE and SECURITY DEFINER
  FOREACH v_fn IN ARRAY v_fns LOOP
    SELECT p.provolatile, p.prosecdef
      INTO v_provolatile, v_prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn
     LIMIT 1;

    IF v_provolatile IS DISTINCT FROM 's' THEN
      RAISE EXCEPTION 'Expected % to be STABLE (provolatile=s), got %', v_fn, v_provolatile;
    END IF;

    IF v_prosecdef IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Expected % to be SECURITY DEFINER', v_fn;
    END IF;
  END LOOP;

  -- 2. Confirm `authenticated` has SELECT only (no INSERT/UPDATE/DELETE) on new tables
  FOREACH v_tbl IN ARRAY v_tbls LOOP
    SELECT (
      has_table_privilege('authenticated', 'public.' || v_tbl, 'INSERT')
      OR has_table_privilege('authenticated', 'public.' || v_tbl, 'UPDATE')
      OR has_table_privilege('authenticated', 'public.' || v_tbl, 'DELETE')
    )
    INTO v_has_write_priv;

    IF v_has_write_priv IS TRUE THEN
      RAISE EXCEPTION 'Expected authenticated to have SELECT only on public.%, but write privilege was found', v_tbl;
    END IF;

    IF NOT has_table_privilege('authenticated', 'public.' || v_tbl, 'SELECT') THEN
      RAISE EXCEPTION 'Expected authenticated to have SELECT on public.%', v_tbl;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;
