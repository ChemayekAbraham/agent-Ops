-- Automated call centre — remember when a step was played and its retry count.
--
-- Africa's Talking delivered a key press (dtmfDigits) without the step
-- details we put in the GetDigits callbackUrl, so the IVR could not tell it
-- was an answer and the call went silent. voice-autocall-ivr now reads such a
-- post against the job's current_step; these columns let it also tell a
-- menu timeout from an early status ping, and keep the wrong-key retry count.

alter table public.voice_autocall_jobs
  add column if not exists last_render_at timestamptz,
  add column if not exists current_tries smallint not null default 0;
