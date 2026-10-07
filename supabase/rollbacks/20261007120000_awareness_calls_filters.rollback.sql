-- Rollback for 20261007120000_awareness_calls_filters.sql
-- That migration replaced the six reports from 20261007110000 with versions that take four more optional filters (district, call
-- result, answer choice, request status) and added awareness_calls_options(). It changed no table or row.
-- To go back: run this file (drops the new versions), then re-run supabase/migrations/20261007110000_awareness_calls_reporting.sql,
-- which recreates the six reports with their original signatures. The Awareness Calls page needs the new versions, so remove or
-- hide that page first.
DROP FUNCTION IF EXISTS public.awareness_calls_options();
DROP FUNCTION IF EXISTS public.awareness_calls_log(timestamptz, timestamptz, text, uuid, text, text, integer, integer, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.awareness_coverage_gaps(timestamptz, timestamptz, text, text, integer, integer, text, text);
DROP FUNCTION IF EXISTS public.awareness_calls_by_caller(timestamptz, timestamptz, text, uuid, text, text, integer, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.awareness_calls_by_team(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.awareness_calls_summary(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.awareness_calls_scoped(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text);
