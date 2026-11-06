-- Withdrawal PIN: an email code is needed to CHANGE or RESET the PIN (CTO, 2026-11-04). Follow-up to
-- 20261104090100_withdrawal_pin.sql and 20261104130000_withdrawal_pin_four_digits.sql.
--
-- Decisions:
--   * Change PIN  = the current PIN AND a code sent to the account's real email. The old "current PIN only"
--                   change in set_withdrawal_pin is closed (it now answers email_code_required).
--   * Forgot PIN  = a code sent to the account's real email. No SMS code, no waiting.
--   * No real email (placeholder address) = neither is possible: the person must add a real email first (code no_email).
--   * After any reset the payout number cannot be changed for number_change_hold_hours (default 48 h), because an
--     email code alone is a weaker proof than the email + SMS version it replaces.
-- The edge function withdrawal-pin-reset drives both flows (service role): it sends the email and hashes the codes.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------- schema
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.withdrawal_pin_resets'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%required_factors%'
  loop
    execute format('alter table public.withdrawal_pin_resets drop constraint %I', c);
  end loop;
end $$;
alter table public.withdrawal_pin_resets
  add constraint withdrawal_pin_resets_required_factors_check
  check (required_factors in ('email', 'email+sms', 'sms'));
alter table public.withdrawal_pin_resets alter column required_factors set default 'email';

-- A "change" code is not tied to a reset.
alter table public.withdrawal_pin_challenges alter column reset_id drop not null;
alter table public.withdrawal_pin_challenges
  add column if not exists purpose text not null default 'reset' check (purpose in ('reset', 'change'));
alter table public.withdrawal_pin_challenges
  drop constraint if exists withdrawal_pin_challenges_purpose_ck;
alter table public.withdrawal_pin_challenges
  add constraint withdrawal_pin_challenges_purpose_ck
  check ((purpose = 'reset' and reset_id is not null) or (purpose = 'change' and reset_id is null));
create index if not exists withdrawal_pin_challenges_change_idx
  on public.withdrawal_pin_challenges (user_id, created_at desc) where purpose = 'change';

-- ---------------------------------------------------------------- forgot PIN: email only
create or replace function public.pin_reset_begin(p_user uuid, p_email_usable boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.withdrawal_pin_resets;
begin
  if not exists (select 1 from public.user_withdrawal_pins where user_id = p_user) then
    return jsonb_build_object('success', false, 'code', 'no_pin');
  end if;
  -- The email code is the only proof, so without a real inbox there is nothing to check: add an email first.
  if not coalesce(p_email_usable, false) then
    return jsonb_build_object('success', false, 'code', 'no_email');
  end if;
  if (select count(*) from public.withdrawal_pin_resets
       where user_id = p_user and requested_at > now() - interval '24 hours') >= 3
     and not exists (select 1 from public.withdrawal_pin_resets where user_id = p_user and status = 'pending') then
    return jsonb_build_object('success', false, 'code', 'rate_limited');
  end if;

  insert into public.withdrawal_pin_resets (user_id, required_factors, release_at)
  values (p_user, 'email', now())
  on conflict (user_id) where status = 'pending' do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.withdrawal_pin_resets where user_id = p_user and status = 'pending';
    return jsonb_build_object('success', true, 'code', 'already_pending', 'reset_id', v_row.id,
      'required_factors', v_row.required_factors, 'release_at', v_row.release_at);
  end if;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  values (p_user, 'WITHDRAWAL_PIN_RESET_REQUESTED', 'withdrawal_pin_resets', v_row.id::text,
          'Forgot-PIN reset requested', jsonb_build_object('required_factors', 'email'));
  return jsonb_build_object('success', true, 'code', 'reset_requested', 'reset_id', v_row.id,
    'required_factors', 'email', 'release_at', v_row.release_at);
end;
$$;

create or replace function public.pin_challenge_issue(
  p_user uuid, p_channel text, p_code_hash text, p_destination_masked text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.withdrawal_pin_config;
  v_reset public.withdrawal_pin_resets;
  v_recent int;
  v_id uuid;
begin
  if p_channel not in ('email', 'sms') or coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('success', false, 'code', 'invalid_request');
  end if;
  select * into v_reset from public.withdrawal_pin_resets where user_id = p_user and status = 'pending';
  if v_reset.id is null then
    return jsonb_build_object('success', false, 'code', 'no_pending_reset');
  end if;
  if (p_channel = 'email' and v_reset.required_factors = 'sms')
     or (p_channel = 'sms' and v_reset.required_factors = 'email') then
    return jsonb_build_object('success', false, 'code', 'channel_not_required');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;

  select count(*) into v_recent from public.withdrawal_pin_challenges
   where user_id = p_user and channel = p_channel and created_at > now() - interval '1 hour';
  if v_recent >= v_cfg.max_codes_per_hour then
    return jsonb_build_object('success', false, 'code', 'rate_limited');
  end if;

  insert into public.withdrawal_pin_challenges (user_id, reset_id, channel, code_hash, destination_masked, expires_at, purpose)
  values (p_user, v_reset.id, p_channel, p_code_hash, p_destination_masked,
          now() + make_interval(mins => v_cfg.challenge_ttl_minutes), 'reset')
  returning id into v_id;
  return jsonb_build_object('success', true, 'code', 'issued', 'challenge_id', v_id,
                            'expires_in_minutes', v_cfg.challenge_ttl_minutes);
end;
$$;

create or replace function public.pin_reset_complete(
  p_user uuid, p_sms_code_hash text, p_email_code_hash text, p_new_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.withdrawal_pin_config;
  v_reset public.withdrawal_pin_resets;
  v_res jsonb;
begin
  if not public.withdrawal_pin_format_ok(p_new_pin) then
    return jsonb_build_object('success', false, 'code', 'weak_pin',
      'message', 'Choose 4 digits that are not all the same and not a run like 1234.');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;
  select * into v_reset from public.withdrawal_pin_resets
   where user_id = p_user and status = 'pending' for update;
  if v_reset.id is null then
    return jsonb_build_object('success', false, 'code', 'no_pending_reset');
  end if;
  if v_reset.release_at > now() then
    return jsonb_build_object('success', false, 'code', 'not_ready', 'release_at', v_reset.release_at);
  end if;

  if v_reset.required_factors in ('sms', 'email+sms') then
    v_res := public.pin_challenge_check(p_user, v_reset.id, 'sms', p_sms_code_hash);
    if (v_res ->> 'ok')::boolean is not true then
      return jsonb_build_object('success', false) || v_res;
    end if;
  end if;
  if v_reset.required_factors in ('email', 'email+sms') then
    v_res := public.pin_challenge_check(p_user, v_reset.id, 'email', p_email_code_hash);
    if (v_res ->> 'ok')::boolean is not true then
      return jsonb_build_object('success', false) || v_res;
    end if;
  end if;

  update public.withdrawal_pin_resets
     set status = 'completed', decided_by = p_user, decided_at = now()
   where id = v_reset.id;
  update public.user_withdrawal_pins
     set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
         failed_attempts = 0, locked_until = null, updated_at = now(),
         number_change_hold_until = case
           when v_cfg.number_change_hold_hours > 0
             then now() + make_interval(hours => v_cfg.number_change_hold_hours)
           else number_change_hold_until end
   where user_id = p_user;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  values (p_user, 'WITHDRAWAL_PIN_RESET_COMPLETED', 'withdrawal_pin_resets', v_reset.id::text,
          'PIN reset after verification code', jsonb_build_object('required_factors', v_reset.required_factors));
  return jsonb_build_object('success', true, 'code', 'pin_reset');
end;
$$;

-- ---------------------------------------------------------------- change PIN: current PIN + email code
-- The browser/app function no longer changes an existing PIN: the first PIN is still set here, a change goes
-- through the edge function (pin_change_issue / pin_change_complete, service role only).
create or replace function public.set_withdrawal_pin(p_new_pin text, p_current_pin text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cfg public.withdrawal_pin_config;
  v_inserted int;
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;
  if not public.withdrawal_pin_format_ok(p_new_pin) then
    return jsonb_build_object('success', false, 'code', 'weak_pin',
      'message', 'Choose 4 digits that are not all the same and not a run like 1234.');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;

  if exists (select 1 from public.user_withdrawal_pins where user_id = v_uid) then
    return jsonb_build_object('success', false, 'code', 'email_code_required',
      'message', 'To change your PIN, enter your current PIN and the code we send to your email.');
  end if;

  insert into public.user_withdrawal_pins (user_id, pin_hash, number_change_hold_until)
  values (v_uid, extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
          case when v_cfg.number_change_hold_hours > 0
               then now() + make_interval(hours => v_cfg.number_change_hold_hours) end)
  on conflict (user_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('success', false, 'code', 'pin_exists');
  end if;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  values (v_uid, 'WITHDRAWAL_PIN_SET', 'user_withdrawal_pins', v_uid::text, 'First withdrawal PIN created',
          jsonb_build_object('number_change_hold_hours', v_cfg.number_change_hold_hours));
  return jsonb_build_object('success', true, 'code', 'pin_set');
end;
$$;

-- Stores the hash of the email code the edge function is about to send for a PIN change. 3 per hour.
create or replace function public.pin_change_issue(p_user uuid, p_code_hash text, p_destination_masked text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.withdrawal_pin_config;
  v_recent int;
  v_id uuid;
begin
  if coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('success', false, 'code', 'invalid_request');
  end if;
  if not exists (select 1 from public.user_withdrawal_pins where user_id = p_user) then
    return jsonb_build_object('success', false, 'code', 'no_pin');
  end if;
  if exists (select 1 from public.withdrawal_pin_resets where user_id = p_user and status = 'pending') then
    return jsonb_build_object('success', false, 'code', 'pin_reset_pending');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;
  select count(*) into v_recent from public.withdrawal_pin_challenges
   where user_id = p_user and channel = 'email' and created_at > now() - interval '1 hour';
  if v_recent >= v_cfg.max_codes_per_hour then
    return jsonb_build_object('success', false, 'code', 'rate_limited');
  end if;
  insert into public.withdrawal_pin_challenges (user_id, reset_id, channel, code_hash, destination_masked, expires_at, purpose)
  values (p_user, null, 'email', p_code_hash, p_destination_masked,
          now() + make_interval(mins => v_cfg.challenge_ttl_minutes), 'change')
  returning id into v_id;
  return jsonb_build_object('success', true, 'code', 'issued', 'challenge_id', v_id,
                            'expires_in_minutes', v_cfg.challenge_ttl_minutes);
end;
$$;

-- Changes the PIN: the current PIN (counted, locks after 5 wrong) AND the email code (counted, 5 tries per code).
create or replace function public.pin_change_complete(
  p_user uuid, p_current_pin text, p_email_code_hash text, p_new_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.withdrawal_pin_config;
  v_res jsonb;
  v_c public.withdrawal_pin_challenges;
begin
  if not public.withdrawal_pin_format_ok(p_new_pin) then
    return jsonb_build_object('success', false, 'code', 'weak_pin',
      'message', 'Choose 4 digits that are not all the same and not a run like 1234.');
  end if;
  if not exists (select 1 from public.user_withdrawal_pins where user_id = p_user) then
    return jsonb_build_object('success', false, 'code', 'no_pin');
  end if;
  if exists (select 1 from public.withdrawal_pin_resets where user_id = p_user and status = 'pending') then
    return jsonb_build_object('success', false, 'code', 'pin_reset_pending');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;

  v_res := public.withdrawal_pin_check(p_user, p_current_pin);
  if (v_res ->> 'ok')::boolean is not true then
    return jsonb_build_object('success', false, 'code', v_res ->> 'code',
      'attempts_left', v_res -> 'attempts_left', 'locked_until', v_res -> 'locked_until');
  end if;

  update public.withdrawal_pin_challenges c
     set attempts = c.attempts + 1
   where c.id = (select id from public.withdrawal_pin_challenges
                  where user_id = p_user and purpose = 'change' and channel = 'email'
                    and verified_at is null and expires_at > now()
                  order by created_at desc limit 1)
     and c.attempts < v_cfg.challenge_max_attempts
  returning c.* into v_c;
  if v_c.id is null then
    return jsonb_build_object('success', false, 'code', 'code_expired_or_used_up', 'channel', 'email');
  end if;
  if v_c.code_hash <> coalesce(p_email_code_hash, '') then
    return jsonb_build_object('success', false, 'code', 'wrong_code', 'channel', 'email',
      'attempts_left', greatest(0, v_cfg.challenge_max_attempts - v_c.attempts));
  end if;

  update public.withdrawal_pin_challenges set verified_at = now() where id = v_c.id;
  update public.user_withdrawal_pins
     set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
         failed_attempts = 0, locked_until = null, updated_at = now()
   where user_id = p_user;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason)
  values (p_user, 'WITHDRAWAL_PIN_CHANGED', 'user_withdrawal_pins', p_user::text,
          'PIN changed with the current PIN and an email code');
  return jsonb_build_object('success', true, 'code', 'pin_changed');
end;
$$;

-- ---------------------------------------------------------------- grants
revoke execute on function
  public.pin_change_issue(uuid, text, text),
  public.pin_change_complete(uuid, text, text, text)
from public, anon, authenticated;
grant execute on function
  public.pin_change_issue(uuid, text, text),
  public.pin_change_complete(uuid, text, text, text)
to service_role;
-- CREATE OR REPLACE keeps the grants of the functions replaced above.
