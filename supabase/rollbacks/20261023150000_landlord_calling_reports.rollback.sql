-- =============================================================================
-- Rollback: 20261023150000_landlord_calling_reports.rollback.sql
-- Purpose:  Cleanly drop the 7 Landlord Calling Center reporting RPCs and
--           their internal helpers without touching any tenant or shared objects.
-- =============================================================================

DROP FUNCTION IF EXISTS public.landlord_cc_round_report(uuid);
DROP FUNCTION IF EXISTS public.landlord_cc_concerns_report(date, date);
DROP FUNCTION IF EXISTS public.landlord_cc_landlord_call_log(date, date, integer, integer);
DROP FUNCTION IF EXISTS public.landlord_cc_staff_performance(date, date);
DROP FUNCTION IF EXISTS public.landlord_cc_coverage(timestamptz);
DROP FUNCTION IF EXISTS public.landlord_cc_weekly_report(date);
DROP FUNCTION IF EXISTS public.landlord_cc_daily_summary(date, date);
DROP FUNCTION IF EXISTS public._landlord_cc_events_in_window(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public._landlord_cc_can_view_unmasked_phone();
