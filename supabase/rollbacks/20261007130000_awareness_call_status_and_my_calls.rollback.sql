-- Rollback for 20261007130000_awareness_call_status_and_my_calls.sql
-- The migration only ADDED three read-only functions; no table, row or existing object was changed, so rolling back is dropping them.
DROP FUNCTION IF EXISTS public.my_awareness_calls_log(timestamptz, timestamptz, integer, integer);
DROP FUNCTION IF EXISTS public.my_awareness_calls_summary(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.awareness_call_status_for_requests(uuid[]);
