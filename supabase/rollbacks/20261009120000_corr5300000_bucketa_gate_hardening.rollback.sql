-- Rollback for supabase/pending/20261009120000_corr5300000_bucketa_gate_hardening.sql
-- Restores the grants exactly as they were on 2026-10-09 07:06 UTC (including the unsafe ones).
BEGIN;
GRANT EXECUTE ON FUNCTION public.cfo_corr_5300000_post(uuid, text, text) TO service_role, sandbox_exec_wirntoujqoyjobfhyelc;
GRANT EXECUTE ON FUNCTION public.cfo_corr_5300000_preflight()            TO service_role, sandbox_exec_wirntoujqoyjobfhyelc;
GRANT EXECUTE ON FUNCTION public.cfo_bucket_a_post(uuid, text, text)     TO service_role, sandbox_exec_wirntoujqoyjobfhyelc;
GRANT EXECUTE ON FUNCTION public.cfo_bucket_a_preflight()                TO service_role, sandbox_exec_wirntoujqoyjobfhyelc;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cfo_approval_approvers, public.cfo_corr_5300000_events,
  public.cfo_corr_5300000_lines, public.cfo_bucket_a_events, public.cfo_bucket_a_package_lines TO service_role;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cfo_approval_approvers TO authenticated;
GRANT UPDATE, TRUNCATE, TRIGGER ON public.cfo_corr_5300000_events, public.cfo_corr_5300000_lines,
  public.cfo_bucket_a_events, public.cfo_bucket_a_package_lines TO authenticated;
GRANT INSERT ON public.cfo_approval_approvers, public.cfo_corr_5300000_events, public.cfo_corr_5300000_lines,
  public.cfo_bucket_a_events, public.cfo_bucket_a_package_lines TO sandbox_exec, sandbox_exec_wirntoujqoyjobfhyelc;
DROP POLICY IF EXISTS "Approver list is never writable through the API" ON public.cfo_approval_approvers;
DROP INDEX IF EXISTS public.general_ledger_cfo_corr_5300000_key_uniq;
DROP INDEX IF EXISTS public.cfo_corr_5300000_events_one_commit;
DROP FUNCTION IF EXISTS public._cfo_corr_5300000_hash_v2();
COMMIT;
