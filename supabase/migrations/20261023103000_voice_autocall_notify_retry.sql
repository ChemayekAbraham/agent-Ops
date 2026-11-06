-- Automated call centre — never lose an after-call SMS.
--
-- The voice_autocall_sms_on_call_done trigger fires one pg_net request. On
-- 2026-10-23 10:30 a burst of pg_net DNS timeouts (5 s default) dropped it,
-- and with no retry the monitor and tenant self-pay SMS were simply lost.
--
-- 1. jobs.notified_at: set by voice-autocall-notify once a finished call's
--    texts are handled. voice-autocall-dialer re-sends (each minute) any
--    finished call still unmarked after 2 minutes, up to 2 hours old. The SMS
--    idempotency keys and the tenant episode key stop double texts.
-- 2. The trigger's request (and the test-call dialer kick) wait 30 s, not 5.

alter table public.voice_autocall_jobs add column if not exists notified_at timestamptz;

-- Calls finished before this change were already texted (or are too old to matter).
update public.voice_autocall_jobs set notified_at = coalesce(ended_at, updated_at)
where notified_at is null
  and status in ('completed', 'no_answer', 'busy', 'failed')
  and coalesce(ended_at, updated_at) < now() - interval '2 hours';

create index if not exists voice_autocall_jobs_unnotified
  on public.voice_autocall_jobs (ended_at)
  where notified_at is null and status in ('completed', 'no_answer', 'busy', 'failed');

create or replace function public.voice_autocall_notify_call_done()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/voice-autocall-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'email_queue_service_role_key' limit 1), '')
    ),
    body := jsonb_build_object('job', new.id),
    timeout_milliseconds := 30000
  );
  return new;
end;
$$;

create or replace function public.voice_autocall_kick_dialer()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/voice-autocall-dialer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'email_queue_service_role_key' limit 1), '')
    ),
    body := jsonb_build_object('kick', 'test_call', 'job', new.id),
    timeout_milliseconds := 30000
  );
  return new;
end;
$$;

revoke all on function public.voice_autocall_notify_call_done() from public, anon, authenticated;
revoke all on function public.voice_autocall_kick_dialer() from public, anon, authenticated;
