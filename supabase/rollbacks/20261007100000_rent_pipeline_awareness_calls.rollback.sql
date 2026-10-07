-- Rollback for 20261007100000_rent_pipeline_awareness_calls.sql
-- The migration only ADDED one table, one trigger function and two functions; nothing in the rent pipeline was changed.
-- WARNING: dropping the table permanently deletes every awareness call recorded so far (the table is append-only by design).
-- Export it first if any calls have been recorded:  SELECT * FROM public.rent_pipeline_awareness_calls;
DROP FUNCTION IF EXISTS public.get_awareness_calls_for_request(uuid);
DROP FUNCTION IF EXISTS public.record_awareness_call(uuid, text, text, timestamptz, text, uuid, text, text, text, text);
DROP TABLE IF EXISTS public.rent_pipeline_awareness_calls;
DROP FUNCTION IF EXISTS public.rent_pipeline_awareness_calls_append_only();
