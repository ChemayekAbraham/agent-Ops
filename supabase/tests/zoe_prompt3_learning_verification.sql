-- Verification SQL for Prompt 3: Make Zoe learn and get used
SELECT jsonb_build_object(
  'kb_zero_hits_table_exists', to_regclass('public.staff_assistant_kb_zero_hits') IS NOT NULL,
  'kb_zero_hits_mfa_policy', EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'staff_assistant_kb_zero_hits' AND policyname = 'mfa_required_for_staff'
  ),
  'teaching_queue_fn_exists', EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'staff_assistant_department_teaching_queue'
  ),
  'teach_fn_exists', EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'staff_assistant_teach_from_review_queue'
  ),
  'my_taught_updates_fn_exists', EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'assistant_staff_my_taught_updates'
  ),
  'role_goals_fn_exists', EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'staff_assistant_role_goals_and_measures'
  ),
  'learning_log_row_count', (
    SELECT count(*) FROM public.staff_assistant_learning_log
  ),
  'kb_published_count', (
    SELECT count(*) FROM public.staff_assistant_knowledge_base WHERE review_status = 'published'
  )
) AS prompt3_verification;
