ALTER TABLE public.crm_call_sessions
  DROP CONSTRAINT IF EXISTS crm_call_sessions_ended_by_ck;

ALTER TABLE public.crm_call_sessions
  ADD CONSTRAINT crm_call_sessions_ended_by_ck
  CHECK (ended_by IS NULL OR ended_by = ANY (ARRAY['crm_user'::text,'remote_party'::text,'network'::text,'unknown'::text,'system_reaper'::text]));