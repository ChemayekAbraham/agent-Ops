-- Rollback for 20261026160000_staff_assistant_actions_schedules_and_brief.sql

DROP FUNCTION IF EXISTS public.staff_assistant_dispatch_due_reminders();
DROP FUNCTION IF EXISTS public.staff_assistant_run_scheduled_report_as_owner(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.staff_assistant_check_owner_access(uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_set_morning_brief_prefs(boolean, text, boolean);
DROP FUNCTION IF EXISTS public.staff_assistant_cancel_schedule(uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_create_schedule(text, text, text, jsonb, text, text[], integer, text, text, uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_compute_next_run(text, text, integer, timestamptz);
DROP FUNCTION IF EXISTS public.staff_assistant_send_colleague_notification(text, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_cancel_reminder(uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_create_reminder(text, timestamptz, text, uuid);
DROP FUNCTION IF EXISTS public.assistant_staff_my_reminders_and_schedules(boolean);

DROP TABLE IF EXISTS public.staff_assistant_preferences CASCADE;
DROP TABLE IF EXISTS public.staff_assistant_schedules CASCADE;
DROP TABLE IF EXISTS public.staff_assistant_reminders CASCADE;
