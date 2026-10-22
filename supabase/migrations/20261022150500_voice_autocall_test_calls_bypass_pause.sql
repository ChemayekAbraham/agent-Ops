-- Automated call centre — test calls ignore category / master pauses and dial
-- at once.
--
-- 1. voice_autocall_claim: a paused category (or "Pause all") no longer holds
--    back a test call. A person's own opt-out (pressing 9) and a staff pause on
--    that person still apply — those are about the person, not the campaign.
-- 2. Queuing a test call kicks the dialer immediately instead of waiting for
--    the next per-minute cron run. pg_net sends the request only after the
--    inserting transaction commits, so the dialer always sees the new job.

create or replace function public.voice_autocall_claim(p_channels integer)
returns setof public.voice_autocall_jobs
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now_local timestamp := now() at time zone 'Africa/Kampala';
  v_dow int := extract(isodow from (now() at time zone 'Africa/Kampala'))::int;
  v_free int;
begin
  select greatest(0, coalesce(p_channels, 0) - count(*))::int into v_free
  from public.voice_autocall_jobs where status in ('dialing', 'in_progress');
  if v_free = 0 then return; end if;

  return query
  with picked as (
    select j.id
    from public.voice_autocall_jobs j
    left join public.voice_autocall_campaigns c on c.id = j.campaign_id
    join public.voice_autocall_category_settings cs on cs.category = j.category
    where j.status = 'queued'
      and j.next_attempt_at <= now()
      and j.expires_at > now()
      and (j.is_test or not cs.paused)
      and not public.voice_autocall_is_blocked(j.person_id, j.phone, j.category)
      and (
        -- Test calls may run 07:00–21:00 any day, paused or not.
        (j.is_test and v_now_local::time between time '07:00' and time '21:00')
        or (not j.is_test
            and c.status = 'active'
            and v_dow between 1 and 6 and v_dow = any (c.days_of_week)
            and v_now_local::time >= greatest(c.window_start, time '08:00')
            and v_now_local::time < least(c.window_end, time '19:00'))
      )
    order by j.is_test desc, j.next_attempt_at
    limit v_free
    for update of j skip locked
  )
  update public.voice_autocall_jobs j set
    status = 'dialing',
    attempts = j.attempts + 1,
    last_attempt_at = now(),
    at_session_id = null,
    current_step = null,
    callback_count = 0,
    answered_at = null,
    ended_at = null,
    duration_seconds = null,
    hangup_cause = null,
    failure_reason = null,
    updated_at = now()
  from picked where j.id = picked.id
  returning j.*;
end;
$$;

revoke all on function public.voice_autocall_claim(integer) from public, anon, authenticated;
grant execute on function public.voice_autocall_claim(integer) to service_role;

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
    body := jsonb_build_object('kick', 'test_call', 'job', new.id)
  );
  return new;
end;
$$;

revoke all on function public.voice_autocall_kick_dialer() from public, anon, authenticated;

drop trigger if exists voice_autocall_kick_on_test_call on public.voice_autocall_jobs;
create trigger voice_autocall_kick_on_test_call
  after insert on public.voice_autocall_jobs
  for each row when (new.is_test)
  execute function public.voice_autocall_kick_dialer();
