-- Rollback for 20261031140000_staff_assistant_prompt2_files_coaching_projects_and_zoe_ro.sql
DELETE FROM public.staff_assistant_data_catalog
WHERE view_name IN (
  'zoe_ro.calling_my_space_officer_daily',
  'zoe_ro.tenants_directory_by_stage_and_location',
  'zoe_ro.operations_desk_turnaround_summary',
  'zoe_ro.tenants_first_seven_days_cohort'
);

DROP VIEW IF EXISTS zoe_ro.tenants_first_seven_days_cohort;
DROP VIEW IF EXISTS zoe_ro.operations_desk_turnaround_summary;
DROP VIEW IF EXISTS zoe_ro.tenants_directory_by_stage_and_location;
DROP VIEW IF EXISTS zoe_ro.calling_my_space_officer_daily;

DROP FUNCTION IF EXISTS public.assistant_staff_team_work_summary(text, date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_my_work_summary(date, date);
DROP FUNCTION IF EXISTS public.staff_assistant_delete_project(uuid);
DROP FUNCTION IF EXISTS public.staff_assistant_list_projects();
DROP FUNCTION IF EXISTS public.staff_assistant_upsert_project(uuid, text, text, uuid[]);
DROP FUNCTION IF EXISTS public.staff_assistant_purge_expired_uploads();
DROP TRIGGER IF EXISTS trg_staff_assistant_uploads_limit_per_chat ON public.staff_assistant_uploads;
DROP FUNCTION IF EXISTS public.staff_assistant_enforce_upload_limits();
DROP TABLE IF EXISTS public.staff_assistant_uploads;
ALTER TABLE public.staff_assistant_conversations DROP COLUMN IF EXISTS project_id;
DROP TABLE IF EXISTS public.staff_assistant_projects;
