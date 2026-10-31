-- Rollback for 20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql
BEGIN;

DROP FUNCTION IF EXISTS public.assistant_staff_run_query(text, text);
DROP FUNCTION IF EXISTS public.zoe_ro_validate_query(text);
DROP FUNCTION IF EXISTS public.staff_assistant_log_query(text, text, text, text[], integer, boolean, integer, text, text);
DROP FUNCTION IF EXISTS public.get_data_catalog(text);
DROP FUNCTION IF EXISTS public.assistant_staff_data_catalog(text);

DROP TRIGGER IF EXISTS trg_staff_assistant_queries_append_only ON public.staff_assistant_queries;
DROP FUNCTION IF EXISTS public.trg_guard_staff_assistant_queries_append_only();
DROP TABLE IF EXISTS public.staff_assistant_queries;
DROP TABLE IF EXISTS public.staff_assistant_data_catalog;

DROP SCHEMA IF EXISTS zoe_ro CASCADE;

DROP FUNCTION IF EXISTS public.zoe_ro_require_area(text);
DROP FUNCTION IF EXISTS public.zoe_ro_area_is_sensitive(text);
DROP FUNCTION IF EXISTS public.zoe_ro_area_allowed(text);

COMMIT;
