-- Rollback for 20261116103000 (doc 274). Drops the event triggers first so DDL stops writing to the log.
-- The log table is kept by default (it is evidence); uncomment the last line to remove it too.
drop event trigger if exists zz_schema_change_log;
drop event trigger if exists zz_schema_change_log_drop;
drop function if exists public.get_backend_change_digest(timestamptz, timestamptz);
drop function if exists public.schema_change_log_capture();
drop function if exists public.schema_change_log_capture_drop();
-- drop table if exists public.schema_change_log;
