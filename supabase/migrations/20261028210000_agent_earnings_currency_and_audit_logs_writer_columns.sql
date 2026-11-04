-- Edge functions wrote columns that do not exist, so the rows were silently dropped (doc 247 step 51).
-- Applied to production by hand; this file is the record. All changes are additive and nullable or defaulted.

-- agent_earnings.currency: approve-listing-bonus, credit-listing-bonus and disburse-rent-to-landlord insert
-- currency 'UGX'. PostgREST refused the whole insert (400, 32 in 3 hours) and the functions do not check the
-- result, so listing-bonus and rent-funded-bonus earnings history rows were never written.
alter table public.agent_earnings add column if not exists currency text not null default 'UGX';

-- audit_logs: twelve edge-function inserts send columns the table lacks (114 refusals in 12 hours, last 14:27).
--   gmail-poll-transactions (every minute, withdrawal auto-approval trail): new_data
--   approve-deposit, vendor-login, vendor-mark-receipt:                      performed_by
--   admin-update-user-identity, recover-user-auth:                           actor_id, details
--   register-proxy-funder, send-funder-statement:                            details, target_user_id, is_proxy, audit_reason
-- Add the columns so the trail is kept as written; aligning the writers to old_values/new_values/metadata/user_id
-- is a later clean-up. details is jsonb because some writers send an object and some a string.
alter table public.audit_logs
  add column if not exists performed_by uuid,
  add column if not exists actor_id uuid,
  add column if not exists target_user_id uuid,
  add column if not exists new_data jsonb,
  add column if not exists details jsonb,
  add column if not exists is_proxy boolean,
  add column if not exists audit_reason text;

-- Two writers send `action` and no `action_type` (NOT NULL); keep the row instead of refusing it.
create or replace function public.trg_audit_logs_default_action_type()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.action_type is null then
    new.action_type := coalesce(nullif(new.action, ''), 'unspecified');
  end if;
  return new;
end $$;

drop trigger if exists trg_audit_logs_default_action_type on public.audit_logs;
create trigger trg_audit_logs_default_action_type before insert on public.audit_logs
  for each row execute function public.trg_audit_logs_default_action_type();
