-- Rollback for 20261007110000_awareness_calls_reporting.sql
-- The migration only ADDED six read-only functions; no table, row or existing object was changed, so rolling back is dropping them.
-- Drop the reports first, then the shared filter they call.
DROP FUNCTION IF EXISTS public.awareness_calls_log(timestamptz, timestamptz, text, uuid, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.awareness_coverage_gaps(timestamptz, timestamptz, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.awareness_calls_by_caller(timestamptz, timestamptz, text, uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.awareness_calls_by_team(timestamptz, timestamptz, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.awareness_calls_summary(timestamptz, timestamptz, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.awareness_calls_scoped(timestamptz, timestamptz, text, uuid, text, text);
