-- Rollback for 20261019100000_rent_request_timing.sql: only read-only functions were added, so there is no data to restore.
-- Nothing existing was changed.
DROP FUNCTION IF EXISTS public.rent_request_timing_history(uuid);
DROP FUNCTION IF EXISTS public.rent_request_timing(uuid[]);
DROP FUNCTION IF EXISTS public._rt_evidence(uuid[]);
DROP FUNCTION IF EXISTS public._rt_compute(jsonb, timestamptz, boolean);
DROP FUNCTION IF EXISTS public._rt_desk_name(integer);
DROP FUNCTION IF EXISTS public._rt_rank(text);
DROP FUNCTION IF EXISTS public._rt_desk_of_status(text);
DROP FUNCTION IF EXISTS public._rt_ts(text);
