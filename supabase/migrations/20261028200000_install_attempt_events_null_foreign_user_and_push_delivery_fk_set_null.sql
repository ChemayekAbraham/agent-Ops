-- Two more refusals found in the 14:00 UTC scan (doc 247 step 50). Applied to production by hand; this file is the record.

-- install_attempt_events: same cause as login_phase_events (step 47b). The browser stamps a user_id that
-- is not the request token's user, the insert policy refuses it. Store it as null instead.
create or replace function public.trg_install_attempt_events_null_foreign_user()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.user_id is not null and new.user_id is distinct from (select auth.uid()) then
    new.user_id := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_install_attempt_events_null_foreign_user on public.install_attempt_events;
create trigger trg_install_attempt_events_null_foreign_user before insert on public.install_attempt_events
  for each row execute function public.trg_install_attempt_events_null_foreign_user();

-- push_subscriptions: removing an expired subscription (done after a push service answers gone) was blocked
-- by tenant_notification_deliveries.push_subscription_id, so dead endpoints stayed and were retried forever.
-- The column is nullable; keep the delivery history and just drop the link.
alter table public.tenant_notification_deliveries
  drop constraint tenant_notification_deliveries_push_subscription_id_fkey,
  add constraint tenant_notification_deliveries_push_subscription_id_fkey
    foreign key (push_subscription_id) references public.push_subscriptions(id) on delete set null;
