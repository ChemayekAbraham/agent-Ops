-- Automated call centre — script wording, T1 timeouts, and an SMS after every call.
--
-- 1. T1 "Rent due today": both menus (name confirmation and main message)
--    wait 20 seconds for a key instead of 10.
-- 2. Every script that said "This call is recorded for quality" now says
--    "This call may be recorded for quality" (T1, T2, P1, P2). Whole-call
--    recording is not on yet, so "may be" is the accurate notice.
--    Each edit is a new script version; the old words stay in the history.
-- 3. When a call reaches its final result (answered, no answer, busy or
--    failed), voice-autocall-notify texts a summary to the numbers in
--    voice_autocall_system_status.call_notify_phones (+256748747134).
--    Retried attempts do not text; only the final result does.

-- ───────────────────────── 1 + 2: script edits ─────────────────────────

do $$
declare
  s record;
  v_new jsonb;
begin
  for s in select * from public.voice_autocall_scripts where code in ('T1', 'T2', 'P1', 'P2') for update loop
    v_new := replace(s.steps::text, 'This call is recorded for quality', 'This call may be recorded for quality')::jsonb;
    if s.code = 'T1' then
      v_new := jsonb_set(v_new, '{steps,confirm,timeout}', '20'::jsonb);
      v_new := jsonb_set(v_new, '{steps,main,timeout}', '20'::jsonb);
    end if;
    continue when v_new = s.steps;
    perform public.voice_autocall_validate_steps(v_new);

    update public.voice_autocall_scripts set steps = v_new, version = version + 1, updated_at = now()
    where id = s.id;
    insert into public.voice_autocall_script_versions (script_id, version, name, occasion, description, steps)
    values (s.id, s.version + 1, s.name, s.occasion, s.description, v_new);
  end loop;
end $$;

-- ───────────────────────── 3: SMS after every finished call ─────────────────────────

alter table public.voice_autocall_system_status
  add column if not exists call_notify_phones text[] not null default array['+256748747134'];

update public.voice_autocall_system_status set call_notify_phones = array['+256748747134'] where id = 1;

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
    body := jsonb_build_object('job', new.id)
  );
  return new;
end;
$$;

revoke all on function public.voice_autocall_notify_call_done() from public, anon, authenticated;

drop trigger if exists voice_autocall_sms_on_call_done on public.voice_autocall_jobs;
create trigger voice_autocall_sms_on_call_done
  after update of status on public.voice_autocall_jobs
  for each row
  when (old.status in ('dialing', 'in_progress') and new.status in ('completed', 'no_answer', 'busy', 'failed'))
  execute function public.voice_autocall_notify_call_done();
