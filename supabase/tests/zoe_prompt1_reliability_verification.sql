-- Verification SQL for Prompt 1: Make Zoe honest and reliable
SELECT jsonb_build_object(
  'real_use_dashboard_fn_exists', EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'staff_assistant_real_use_dashboard'
  ),
  'real_use_dashboard_anon_cannot_execute', NOT has_function_privilege(
    'anon', 'public.staff_assistant_real_use_dashboard(integer)', 'EXECUTE'
  ),
  'real_use_dashboard_authenticated_can_execute', has_function_privilege(
    'authenticated', 'public.staff_assistant_real_use_dashboard(integer)', 'EXECUTE'
  ),
  'messages_requested_model_col', EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'staff_assistant_messages' AND column_name = 'requested_model'
  ),
  'messages_gateway_model_col', EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'staff_assistant_messages' AND column_name = 'gateway_model'
  ),
  'messages_ttfb_ms_col', EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'staff_assistant_messages' AND column_name = 'ttfb_ms'
  ),
  'unanswered_null_error_codes', (
    SELECT count(*) FROM public.staff_assistant_unanswered WHERE error_code IS NULL OR btrim(error_code) = ''
  ),
  'unanswered_trigger_exists', EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_staff_assistant_unanswered_ensure_error_code'
  )
) AS prompt1_verification;
