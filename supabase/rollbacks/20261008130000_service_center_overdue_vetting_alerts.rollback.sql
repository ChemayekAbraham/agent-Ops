-- Rollback for 20261008130000_service_center_overdue_vetting_alerts.sql
-- Only new objects were added; no existing table, row or function was changed. The alert log is dropped with its data (audit of dialog shows only).
DROP FUNCTION IF EXISTS public.set_service_center_vetting_policy(boolean, integer, timestamptz);
DROP FUNCTION IF EXISTS public.get_overdue_vetting_overview();
DROP FUNCTION IF EXISTS public.log_overdue_vetting_alert_shown();
DROP FUNCTION IF EXISTS public.get_my_overdue_vetting();
DROP FUNCTION IF EXISTS public.service_center_vetting_items();
DROP TABLE IF EXISTS public.service_center_overdue_alert_log;
DROP TABLE IF EXISTS public.service_center_vetting_policy;
