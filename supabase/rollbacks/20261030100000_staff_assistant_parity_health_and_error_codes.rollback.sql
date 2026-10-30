-- Rollback for 20261030100000_staff_assistant_parity_health_and_error_codes.sql
BEGIN;

DROP FUNCTION IF EXISTS public.staff_assistant_error_summary(integer);
DROP FUNCTION IF EXISTS public.staff_assistant_health();
DROP FUNCTION IF EXISTS public.assistant_staff_get_data_catalog(text);
DROP FUNCTION IF EXISTS public.staff_assistant_get_config();

DROP INDEX IF EXISTS public.idx_staff_assistant_unanswered_error_code_created;

ALTER TABLE public.staff_assistant_unanswered
  DROP COLUMN IF EXISTS error_detail,
  DROP COLUMN IF EXISTS error_code;

COMMIT;
