-- Rollback for 20261025230000_staff_assistant_foundation.sql
-- Unschedules the daily retention cron job and removes the Zoe foundation functions and tables.
-- Nothing outside Zoe (staff_assistant_*) is touched.

DO $rb$
DECLARE
  v_job_id bigint;
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    FOR v_job_id IN
      SELECT jobid FROM cron.job WHERE jobname = 'staff-assistant-purge-old-history'
    LOOP
      PERFORM cron.unschedule(v_job_id);
    END LOOP;
  END IF;
END
$rb$;

DROP FUNCTION IF EXISTS public.staff_assistant_purge_old_history();
DROP FUNCTION IF EXISTS public.staff_assistant_require_staff();
DROP FUNCTION IF EXISTS public.staff_assistant_has_access();

DROP TABLE IF EXISTS public.staff_assistant_unanswered;
DROP TABLE IF EXISTS public.staff_assistant_feedback;
DROP TABLE IF EXISTS public.staff_assistant_messages;
DROP TABLE IF EXISTS public.staff_assistant_conversations;
DROP TABLE IF EXISTS public.staff_assistant_config;
