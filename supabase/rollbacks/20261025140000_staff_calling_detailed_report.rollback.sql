-- =============================================================================
-- Rollback: 20261025140000_staff_calling_detailed_report.rollback.sql
-- =============================================================================

DROP FUNCTION IF EXISTS public.staff_calling_detailed_report(timestamptz, timestamptz);
