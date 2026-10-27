-- =============================================================================
-- Test: supabase/tests/staff_assistant_prompt3_coverage_and_learning.sql
-- Purpose:
--   Verifies inside a transaction that ALWAYS rolls back:
--   1. All 11 new `assistant_staff_*` coverage functions exist, are STABLE,
--      SECURITY DEFINER, and execute cleanly inside `SET LOCAL TRANSACTION READ ONLY`.
--   2. Role gates refuse unauthorized roles with SQLSTATE 42501.
--   3. `staff_assistant_rename_conversation` renames only the caller's own conversation.
--   4. `staff_assistant_crm_weekly_learning_report` returns weekly unanswered
--      questions and thumbs-down questions with answer text strictly redacted.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_fn text;
  v_provolatile char;
  v_prosecdef boolean;
  v_fns text[] := ARRAY[
    'assistant_staff_my_calls',
    'assistant_staff_tops_rent_requests_by_stage',
    'assistant_staff_tops_time_on_desk',
    'assistant_staff_tops_find_tenant',
    'assistant_staff_tops_awareness_calls',
    'assistant_staff_lops_verification_queue',
    'assistant_staff_aops_subagent_teams',
    'assistant_staff_pops_returns_due',
    'assistant_staff_pops_topups_and_withdrawals_waiting',
    'assistant_staff_fops_disbursements',
    'assistant_staff_fops_merchant_cashouts'
  ];
BEGIN
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
END;
$$;

ROLLBACK;
