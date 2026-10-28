-- login_phase_events: 39 RLS violations a day (doc 247 step 47b).
-- The browser stamps the user id it remembers; during sign-in or after an account switch the request
-- token belongs to someone else (or to anon), and the insert policy refused the whole batch.
-- Telemetry only: store a user_id that is not the caller's own as null instead of refusing the batch.
-- Applied to production by hand; this file is the record.
create or replace function public.trg_login_phase_events_null_foreign_user()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.user_id is not null and new.user_id is distinct from (select auth.uid()) then
    new.user_id := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_login_phase_events_null_foreign_user on public.login_phase_events;
create trigger trg_login_phase_events_null_foreign_user before insert on public.login_phase_events
  for each row execute function public.trg_login_phase_events_null_foreign_user();
