-- Rollback for 20261029180000_staff_assistant_prompt4_consultant_and_proactive.sql
BEGIN;

DROP FUNCTION IF EXISTS public.staff_assistant_weekly_unanswered_list(integer);

DROP INDEX IF EXISTS public.idx_staff_assistant_feedback_kind_created;

ALTER TABLE public.staff_assistant_feedback
  DROP COLUMN IF EXISTS report_kind;

ALTER TABLE public.staff_assistant_config
  DROP COLUMN IF EXISTS web_research_enabled;

COMMIT;
