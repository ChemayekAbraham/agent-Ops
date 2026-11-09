-- E28 staff-desk RPCs: grant EXECUTE to authenticated.
--
-- Migration 20261105060919 created these functions and revoked EXECUTE from
-- public and anon, without a grant to authenticated. In schema public the
-- default privileges leave a new function executable only by postgres and
-- service_role, so PostgREST returns 42501 permission denied for function
-- before the body runs.
--
-- No CREATE OR REPLACE. Bodies are untouched. Live md5(pg_get_functiondef)
-- read from production (project byrzshwlentqvktcksem) before this grant:
--   pipeline_waiting_list(text)                                      b427050af2a9dbc0aed20b592dbb023b
--   desk_sc_people()                                                 81ff6113418204b59ee680e5642bfb7b
--   pipeline_set_waiting(uuid,text,text,text,integer,text,text,uuid) f9aa24f7d54aa84fcbcdae9987e22430
--   pipeline_clear_waiting(uuid,text,text)                           0bc84ce782a9358f40847c22fc2707bb
--
-- Each function rejects an unauthorised caller before it reads or writes.
-- anon stays revoked. service_role already holds EXECUTE; the grant keeps it.

revoke all on function public.pipeline_waiting_list(text) from public, anon;
grant execute on function public.pipeline_waiting_list(text) to authenticated, service_role;

revoke all on function public.desk_sc_people() from public, anon;
grant execute on function public.desk_sc_people() to authenticated, service_role;

revoke all on function public.pipeline_set_waiting(uuid,text,text,text,integer,text,text,uuid) from public, anon;
grant execute on function public.pipeline_set_waiting(uuid,text,text,text,integer,text,text,uuid) to authenticated, service_role;

revoke all on function public.pipeline_clear_waiting(uuid,text,text) from public, anon;
grant execute on function public.pipeline_clear_waiting(uuid,text,text) to authenticated, service_role;
