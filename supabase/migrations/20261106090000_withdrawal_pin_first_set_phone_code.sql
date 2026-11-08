-- Withdrawal PIN: a FIRST PIN needs a one-time code sent to the account's registered phone (doc 263).
--
-- Why: the per-withdrawal SMS code is retired (doc 262). Without it, a person holding only a stolen session on an
-- account that has no PIN could set one and withdraw to a number of their choice at once. The old OTP existed
-- (20260914090000) to stop exactly that. The first PIN now carries that proof once, and then every withdrawal needs
-- only the PIN.
--
-- What changes:
--   * new table withdrawal_pin_setup_codes (service role only; only a sha256 of the code is stored)
--   * pin_setup_issue    stores a code hash (3 per hour, 10 min, one live code at a time)        service role only
--   * pin_setup_complete counts the guess FIRST (5 tries per code), then sets the PIN atomically service role only
--   * set_withdrawal_pin no longer creates a first PIN from the browser/app: it answers 'phone_code_required'
--     (a PIN change still goes through pin_change_issue / pin_change_complete, doc 259)
-- Android: the app's "set PIN" calls set_withdrawal_pin directly and will show an unknown-code error until it is
-- updated to use the edge function actions setup_send_code / setup_complete.

set local lock_timeout = '5s';

create table if not exists public.withdrawal_pin_setup_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  destination_masked text,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists withdrawal_pin_setup_codes_user_idx
  on public.withdrawal_pin_setup_codes (user_id, created_at desc);

alter table public.withdrawal_pin_setup_codes enable row level security;
revoke all on public.withdrawal_pin_setup_codes from public, anon, authenticated;
grant select, insert, update, delete on public.withdrawal_pin_setup_codes to service_role;

-- ---------------------------------------------------------------- issue
create or replace function public.pin_setup_issue(p_user uuid, p_code_hash text, p_destination_masked text default null)
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
  if exists (select 1 from public.user_withdrawal_pins where user_id = p_user) then
    return jsonb_build_object('success', false, 'code', 'pin_exists');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;
  select count(*) into v_recent from public.withdrawal_pin_setup_codes
   where user_id = p_user and created_at > now() - interval '1 hour';
  if v_recent >= v_cfg.max_codes_per_hour then
    return jsonb_build_object('success', false, 'code', 'rate_limited');
  end if;
  -- One live code at a time: an older unused code can no longer be guessed.
  update public.withdrawal_pin_setup_codes set used_at = now()
   where user_id = p_user and used_at is null;
  insert into public.withdrawal_pin_setup_codes (user_id, code_hash, destination_masked, expires_at)
  values (p_user, p_code_hash, p_destination_masked, now() + make_interval(mins => v_cfg.challenge_ttl_minutes))
  returning id into v_id;
  return jsonb_build_object('success', true, 'code', 'issued', 'code_id', v_id,
                            'expires_in_minutes', v_cfg.challenge_ttl_minutes);
end;
$$;

-- ---------------------------------------------------------------- complete
-- The guess is counted BEFORE it is compared, in one UPDATE (the lesson of docs 251 and 256), so parallel guesses
-- cannot out-run the 5-try limit. On a right code the code is spent and the PIN is created in the same call.
create or replace function public.pin_setup_complete(p_user uuid, p_code_hash text, p_new_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.withdrawal_pin_config;
  v_row public.withdrawal_pin_setup_codes;
  v_spent int;
  v_inserted int;
begin
  if not public.withdrawal_pin_format_ok(p_new_pin) then
    return jsonb_build_object('success', false, 'code', 'weak_pin',
      'message', 'Choose 4 digits that are not all the same and not a run like 1234.');
  end if;
  if exists (select 1 from public.user_withdrawal_pins where user_id = p_user) then
    return jsonb_build_object('success', false, 'code', 'pin_exists');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;

  update public.withdrawal_pin_setup_codes c
     set attempts = c.attempts + 1
   where c.id = (select s.id from public.withdrawal_pin_setup_codes s
                  where s.user_id = p_user and s.used_at is null and s.expires_at > now()
                  order by s.created_at desc limit 1)
     and c.attempts < v_cfg.challenge_max_attempts
  returning c.* into v_row;
  if v_row.id is null then
    return jsonb_build_object('success', false, 'code', 'code_expired_or_used_up', 'channel', 'sms');
  end if;

  if v_row.code_hash is distinct from p_code_hash then
    return jsonb_build_object('success', false, 'code', 'wrong_code', 'channel', 'sms',
      'attempts_left', greatest(v_cfg.challenge_max_attempts - v_row.attempts, 0));
  end if;

  update public.withdrawal_pin_setup_codes set used_at = now() where id = v_row.id and used_at is null;
  get diagnostics v_spent = row_count;
  if v_spent = 0 then
    return jsonb_build_object('success', false, 'code', 'code_expired_or_used_up', 'channel', 'sms');
  end if;

  insert into public.user_withdrawal_pins (user_id, pin_hash, number_change_hold_until)
  values (p_user, extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
          case when v_cfg.number_change_hold_hours > 0
               then now() + make_interval(hours => v_cfg.number_change_hold_hours) end)
  on conflict (user_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('success', false, 'code', 'pin_exists');
  end if;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  values (p_user, 'WITHDRAWAL_PIN_SET', 'user_withdrawal_pins', p_user::text,
          'First withdrawal PIN created with a code sent to the registered phone',
          jsonb_build_object('number_change_hold_hours', v_cfg.number_change_hold_hours, 'proof', 'phone_code'));
  return jsonb_build_object('success', true, 'code', 'pin_set');
end;
$$;

-- ---------------------------------------------------------------- the browser/app function no longer makes a first PIN
create or replace function public.set_withdrawal_pin(p_new_pin text, p_current_pin text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;
  if not public.withdrawal_pin_format_ok(p_new_pin) then
    return jsonb_build_object('success', false, 'code', 'weak_pin',
      'message', 'Choose 4 digits that are not all the same and not a run like 1234.');
  end if;
  if exists (select 1 from public.user_withdrawal_pins where user_id = v_uid) then
    return jsonb_build_object('success', false, 'code', 'email_code_required',
      'message', 'To change your PIN, enter your current PIN and the code we send to your email.');
  end if;
  return jsonb_build_object('success', false, 'code', 'phone_code_required',
    'message', 'To set your first PIN we send a code to your registered phone.');
end;
$$;

-- Internal: service role only. CREATE OR REPLACE kept the grants of set_withdrawal_pin (authenticated, service_role).
revoke execute on function public.pin_setup_issue(uuid, text, text), public.pin_setup_complete(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.pin_setup_issue(uuid, text, text), public.pin_setup_complete(uuid, text, text)
  to service_role;
