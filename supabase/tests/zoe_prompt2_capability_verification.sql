-- Verification SQL for Prompt 2: Make Zoe capable, like ChatGPT, Gemini and Copilot
SELECT jsonb_build_object(
  'uploads_bucket_private', EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'staff-assistant-uploads' AND public = false AND file_size_limit = 10485760
  ),
  'uploads_table_exists', to_regclass('public.staff_assistant_uploads') IS NOT NULL,
  'uploads_mfa_policy', EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'staff_assistant_uploads' AND policyname = 'mfa_required_for_staff'
  ),
  'projects_table_exists', to_regclass('public.staff_assistant_projects') IS NOT NULL,
  'projects_mfa_policy', EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'staff_assistant_projects' AND policyname = 'mfa_required_for_staff'
  ),
  'my_work_summary_fn_exists', EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'assistant_staff_my_work_summary'
  ),
  'team_work_summary_fn_exists', EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'assistant_staff_team_work_summary'
  ),
  'new_zoe_ro_views_count', (
    SELECT count(*) FROM information_schema.views
    WHERE table_schema = 'zoe_ro'
      AND table_name IN (
        'calling_my_space_officer_daily',
        'tenants_directory_by_stage_and_location',
        'operations_desk_turnaround_summary',
        'tenants_first_seven_days_cohort'
      )
  )
) AS prompt2_verification;
