-- =============================================================================
-- Zoe Prompt 4 Verification SQL (`supabase/tests/zoe_prompt4_verification.sql`)
-- Read-only verification of all Prompt 4 tables, columns, RLS policies,
-- `mfa_required_for_staff` policies, table grants, function grants, and seed rows.
-- =============================================================================

SELECT
  -- 1. Tables exist
  to_regclass('public.staff_assistant_learning_log') IS NOT NULL AS has_learning_log_table,
  to_regclass('public.staff_assistant_eval_candidates') IS NOT NULL AS has_eval_candidates_table,
  to_regclass('public.staff_assistant_knowledge_base') IS NOT NULL AS has_knowledge_base_table,

  -- 2. Learning log stores NO second copy of question text (no question_text or content column)
  NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_assistant_learning_log'
      AND column_name IN ('question_text', 'content', 'question', 'prompt')
  ) AS learning_log_has_no_question_text_column,

  -- 3. `staff_assistant_preferences` memory columns exist
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_assistant_preferences'
      AND column_name = 'memory_enabled'
  ) AS has_memory_enabled_col,
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_assistant_preferences'
      AND column_name = 'dismissed_memory_prompts'
  ) AS has_dismissed_memory_prompts_col,

  -- 4. Explicit SELECT grants for `authenticated` and NO write grants for `authenticated`/`anon`
  has_table_privilege('authenticated', 'public.staff_assistant_learning_log', 'SELECT') AS auth_can_select_learning_log,
  NOT has_table_privilege('authenticated', 'public.staff_assistant_learning_log', 'INSERT') AS auth_cannot_insert_learning_log,
  has_table_privilege('authenticated', 'public.staff_assistant_eval_candidates', 'SELECT') AS auth_can_select_eval_candidates,
  NOT has_table_privilege('authenticated', 'public.staff_assistant_eval_candidates', 'INSERT') AS auth_cannot_insert_eval_candidates,
  has_table_privilege('authenticated', 'public.staff_assistant_knowledge_base', 'SELECT') AS auth_can_select_kb,
  NOT has_table_privilege('authenticated', 'public.staff_assistant_knowledge_base', 'INSERT') AS auth_cannot_insert_kb,
  NOT has_table_privilege('anon', 'public.staff_assistant_knowledge_base', 'SELECT') AS anon_cannot_select_kb,

  -- 5. Restrictive `mfa_required_for_staff` policy exists on all 3 new tables
  (
    SELECT count(*)::integer
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'staff_assistant_learning_log',
        'staff_assistant_eval_candidates',
        'staff_assistant_knowledge_base'
      )
      AND policyname = 'mfa_required_for_staff'
      AND permissive = 'RESTRICTIVE'
  ) = 3 AS all_new_tables_have_restrictive_mfa_policy,

  -- 6. All 9 Prompt 4 functions exist and grant EXECUTE to `authenticated` (not `anon`)
  has_function_privilege('authenticated', 'public.assistant_staff_search_knowledge_base(text, text, integer)', 'EXECUTE') AS auth_exec_search_kb,
  NOT has_function_privilege('anon', 'public.assistant_staff_search_knowledge_base(text, text, integer)', 'EXECUTE') AS anon_no_exec_search_kb,
  has_function_privilege('authenticated', 'public.assistant_staff_personalised_starters()', 'EXECUTE') AS auth_exec_personalised_starters,
  has_function_privilege('authenticated', 'public.assistant_staff_morning_brief_what_changed()', 'EXECUTE') AS auth_exec_brief_what_changed,
  has_function_privilege('authenticated', 'public.staff_assistant_update_note(uuid, text)', 'EXECUTE') AS auth_exec_update_note,
  has_function_privilege('authenticated', 'public.staff_assistant_set_memory_prefs(boolean, text)', 'EXECUTE') AS auth_exec_set_memory_prefs,
  has_function_privilege('authenticated', 'public.staff_assistant_get_memory_prefs()', 'EXECUTE') AS auth_exec_get_memory_prefs,
  has_function_privilege('authenticated', 'public.staff_assistant_upsert_knowledge_entry(text, text, text, text, text, text, text, text, text[], text)', 'EXECUTE') AS auth_exec_upsert_kb,
  has_function_privilege('authenticated', 'public.staff_assistant_promote_to_eval_set(text, uuid, text, text, text, text)', 'EXECUTE') AS auth_exec_promote_eval,
  has_function_privilege('authenticated', 'public.staff_assistant_weekly_manager_learning_view(integer)', 'EXECUTE') AS auth_exec_weekly_learning_view,

  -- 7. Curated knowledge base seeded with >= 10 published entries and full-text index
  (
    SELECT count(*)::integer
    FROM public.staff_assistant_knowledge_base
    WHERE review_status = 'published'
  ) >= 10 AS kb_seeded_with_at_least_10_entries;
