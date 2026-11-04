-- Withdrawal PIN (doc 258).
--
-- A secret 6-digit PIN, one per user (keyed on profiles.id, which is what the
-- "Welile ID" WEL-xxxxxx is derived from), required before a self-service
-- wallet withdrawal or a payout-number-change request. It is a second factor
-- that does NOT travel by SMS, so someone who got into the account (stolen
-- session, SIM swap, shared phone) still cannot move money out.
--
-- Shape:
--   verify_withdrawal_pin(pin, purpose)  -> checks the PIN, mints a one-use "proof" (5 min)
--   BEFORE INSERT triggers on withdrawal_requests and payout_number_change_requests
--     -> refuse a self-service insert that has no unused proof (and consume it atomically)
--   set / reset functions, all rate-limited, all audited.
--
-- Rollout is controlled by withdrawal_pin_config.enforce_mode:
--   off         nothing is enforced (kill switch)
--   pin_holders only users who have set a PIN are gated   <- default; deploying changes nothing
--                until a user sets one
--   all         every self-service withdrawal needs a PIN (users without one are told to set it)
--
-- Nothing here runs for service_role, staff proxy withdrawals, or any insert where
-- auth.uid() is not the row's own user: those paths keep working unchanged.

-- ---------------------------------------------------------------- config
create table if not exists public.withdrawal_pin_config (
  id boolean primary key default true check (id),
  enforce_mode text not null default 'pin_holders' check (enforce_mode in ('off', 'pin_holders', 'all')),
  max_failed_attempts int not null default 5 check (max_failed_attempts between 3 and 10),
  lockout_minutes int not null default 30 check (lockout_minutes between 5 and 1440),
  proof_ttl_seconds int not null default 300 check (proof_ttl_seconds between 30 and 900),
  reset_cooloff_hours int not null default 48 check (reset_cooloff_hours between 1 and 168),
  number_change_hold_hours int not null default 48 check (number_change_hold_hours between 0 and 168),
  updated_at timestamptz not null default now()
);
insert into public.withdrawal_pin_config (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------- the PIN
create table if not exists public.user_withdrawal_pins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pin_hash text not null,                       -- bcrypt via pgcrypto crypt(); never the PIN itself
  failed_attempts int not null default 0,
  locked_until timestamptz,
  number_change_hold_until timestamptz,         -- no payout-number change until this passes (first set / reset)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One-use proofs that "this session just entered the right PIN for <purpose>".
create table if not exists public.withdrawal_pin_proofs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('withdrawal', 'payout_number_change', 'pin_change')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists withdrawal_pin_proofs_open_idx
  on public.withdrawal_pin_proofs (user_id, purpose, created_at desc) where used_at is null;

-- Forgotten-PIN requests: a cooling-off wait, cancellable by the owner (with the
-- PIN) or by staff.
create table if not exists public.withdrawal_pin_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'cancelled', 'completed')),
  requested_at timestamptz not null default now(),
  release_at timestamptz not null,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text
);
create unique index if not exists withdrawal_pin_resets_one_pending
  on public.withdrawal_pin_resets (user_id) where status = 'pending';

-- Row-level security on with NO policies, and no browser grants: the only way in is the
-- SECURITY DEFINER functions below. service_role keeps full access for ops/support.
alter table public.withdrawal_pin_config enable row level security;
alter table public.user_withdrawal_pins enable row level security;
alter table public.withdrawal_pin_proofs enable row level security;
alter table public.withdrawal_pin_resets enable row level security;

revoke all on public.withdrawal_pin_config, public.user_withdrawal_pins,
              public.withdrawal_pin_proofs, public.withdrawal_pin_resets from public, anon, authenticated;
grant select, insert, update, delete on public.withdrawal_pin_config, public.user_withdrawal_pins,
              public.withdrawal_pin_proofs, public.withdrawal_pin_resets to service_role;

-- ---------------------------------------------------------------- helpers (internal)
create or replace function public.withdrawal_pin_format_ok(p text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p, '') ~ '^[0-9]{6}$'
     and p !~ '^([0-9])\1{5}$'                                         -- 000000, 111111 ...
     and p not in ('012345', '123456', '234567', '345678', '456789',
                   '567890', '098765', '987654', '876543', '765432', '654321', '543210');
$$;

-- Counts the guess FIRST (one atomic UPDATE), then compares. Parallel guesses queue on the
-- row lock, so 30 at once still get exactly max_failed_attempts tries. While locked the
-- UPDATE matches no row, so even the correct PIN is refused until the lock expires.
create or replace function public.withdrawal_pin_check(p_user uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.withdrawal_pin_config;
  v_row public.user_withdrawal_pins;
  v_locked_until timestamptz;
begin
  select * into v_cfg from public.withdrawal_pin_config where id;

  update public.user_withdrawal_pins u
     set failed_attempts = case when u.locked_until is not null and u.locked_until <= now()
                                then 1 else u.failed_attempts + 1 end,
         locked_until = case
           when (case when u.locked_until is not null and u.locked_until <= now()
                      then 1 else u.failed_attempts + 1 end) >= v_cfg.max_failed_attempts
           then now() + make_interval(mins => v_cfg.lockout_minutes)
           else null end,
         updated_at = now()
   where u.user_id = p_user
     and (u.locked_until is null or u.locked_until <= now())
  returning * into v_row;

  if not found then
    select locked_until into v_locked_until from public.user_withdrawal_pins where user_id = p_user;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'no_pin');
    end if;
    return jsonb_build_object('ok', false, 'code', 'pin_locked', 'locked_until', v_locked_until);
  end if;

  if v_row.pin_hash = extensions.crypt(p_pin, v_row.pin_hash) then
    update public.user_withdrawal_pins
       set failed_attempts = 0, locked_until = null, updated_at = now()
     where user_id = p_user;
    return jsonb_build_object('ok', true);
  end if;

  if v_row.locked_until is not null then
    insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    values (p_user, 'WITHDRAWAL_PIN_LOCKED', 'user_withdrawal_pins', p_user::text,
            'Too many wrong PIN attempts', jsonb_build_object('locked_until', v_row.locked_until));
    return jsonb_build_object('ok', false, 'code', 'pin_locked', 'locked_until', v_row.locked_until);
  end if;

  return jsonb_build_object('ok', false, 'code', 'wrong_pin',
    'attempts_left', greatest(0, v_cfg.max_failed_attempts - v_row.failed_attempts));
end;
$$;

-- Consumes the newest unused, unexpired proof. SKIP LOCKED means two parallel
-- inserts cannot both spend the same proof.
create or replace function public.consume_withdrawal_pin_proof(p_user uuid, p_purpose text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id
    from public.withdrawal_pin_proofs
   where user_id = p_user and purpose = p_purpose and used_at is null and expires_at > now()
   order by created_at desc
   limit 1
   for update skip locked;
  if v_id is null then
    return false;
  end if;
  update public.withdrawal_pin_proofs set used_at = now() where id = v_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------- the gate (trigger)
create or replace function public.require_withdrawal_pin_proof()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode text;
  v_has boolean;
  v_purpose text;
begin
  -- Staff, proxy, edge-function-as-service and system inserts: not self-service, not gated here.
  if v_uid is null or v_uid is distinct from NEW.user_id then
    return NEW;
  end if;

  if TG_TABLE_NAME = 'withdrawal_requests' then
    -- Same scope as the withdrawal OTP: cash pickups have no redirection surface.
    if NEW.payout_method is null or NEW.payout_method not in ('mobile_money', 'bank_transfer') then
      return NEW;
    end if;
    v_purpose := 'withdrawal';
  else
    v_purpose := 'payout_number_change';
  end if;

  select enforce_mode into v_mode from public.withdrawal_pin_config where id;
  if v_mode is null or v_mode = 'off' then
    return NEW;
  end if;

  select exists (select 1 from public.user_withdrawal_pins where user_id = v_uid) into v_has;
  if not v_has then
    if v_mode = 'all' then
      raise exception using errcode = '28000', message = 'withdrawal_pin_required',
        detail = 'Set your withdrawal PIN before withdrawing or changing your payout number.';
    end if;
    return NEW;
  end if;

  if not public.consume_withdrawal_pin_proof(v_uid, v_purpose) then
    raise exception using errcode = '28000', message = 'withdrawal_pin_proof_required',
      detail = 'Enter your withdrawal PIN to continue.';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_require_withdrawal_pin_proof on public.withdrawal_requests;
create trigger trg_require_withdrawal_pin_proof
  before insert on public.withdrawal_requests
  for each row execute function public.require_withdrawal_pin_proof();

drop trigger if exists trg_require_withdrawal_pin_proof on public.payout_number_change_requests;
create trigger trg_require_withdrawal_pin_proof
  before insert on public.payout_number_change_requests
  for each row execute function public.require_withdrawal_pin_proof();

-- ---------------------------------------------------------------- browser-callable RPCs
create or replace function public.verify_withdrawal_pin(p_pin text, p_purpose text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cfg public.withdrawal_pin_config;
  v_res jsonb;
  v_hold timestamptz;
  v_reset_release timestamptz;
  v_proof public.withdrawal_pin_proofs;
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;
  if p_purpose is null or p_purpose not in ('withdrawal', 'payout_number_change', 'pin_change') then
    return jsonb_build_object('success', false, 'code', 'invalid_purpose');
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{6}$' then
    return jsonb_build_object('success', false, 'code', 'wrong_pin', 'message', 'Enter your 6-digit PIN.');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;

  -- A pending reset freezes money movement. 'pin_change' stays open: it is how the real
  -- owner cancels a reset they did not ask for.
  if p_purpose <> 'pin_change' then
    select release_at into v_reset_release
      from public.withdrawal_pin_resets where user_id = v_uid and status = 'pending';
    if found then
      return jsonb_build_object('success', false, 'code', 'pin_reset_pending', 'release_at', v_reset_release,
        'message', 'A PIN reset is waiting. Withdrawals are paused until it finishes or is cancelled.');
    end if;
  end if;

  v_res := public.withdrawal_pin_check(v_uid, p_pin);
  if (v_res ->> 'ok')::boolean is not true then
    return jsonb_build_object('success', false, 'code', v_res ->> 'code',
      'attempts_left', v_res -> 'attempts_left', 'locked_until', v_res -> 'locked_until');
  end if;

  if p_purpose = 'payout_number_change' then
    select number_change_hold_until into v_hold from public.user_withdrawal_pins where user_id = v_uid;
    if v_hold is not null and v_hold > now() then
      return jsonb_build_object('success', false, 'code', 'pin_recently_set', 'release_at', v_hold,
        'message', 'For your security the payout number cannot be changed for a while after the PIN was set or reset.');
    end if;
  end if;

  insert into public.withdrawal_pin_proofs (user_id, purpose, expires_at)
  values (v_uid, p_purpose, now() + make_interval(secs => v_cfg.proof_ttl_seconds))
  returning * into v_proof;

  return jsonb_build_object('success', true, 'code', 'verified', 'expires_at', v_proof.expires_at);
end;
$$;

create or replace function public.set_withdrawal_pin(p_new_pin text, p_current_pin text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cfg public.withdrawal_pin_config;
  v_res jsonb;
  v_inserted int;
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;
  if not public.withdrawal_pin_format_ok(p_new_pin) then
    return jsonb_build_object('success', false, 'code', 'weak_pin',
      'message', 'Choose 6 digits that are not all the same and not a run like 123456.');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;

  if not exists (select 1 from public.user_withdrawal_pins where user_id = v_uid) then
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
  end if;

  if p_current_pin is null then
    return jsonb_build_object('success', false, 'code', 'current_pin_required',
      'message', 'Enter your current PIN to change it, or use "Forgot PIN".');
  end if;
  if exists (select 1 from public.withdrawal_pin_resets where user_id = v_uid and status = 'pending') then
    return jsonb_build_object('success', false, 'code', 'pin_reset_pending');
  end if;
  v_res := public.withdrawal_pin_check(v_uid, p_current_pin);
  if (v_res ->> 'ok')::boolean is not true then
    return jsonb_build_object('success', false, 'code', v_res ->> 'code',
      'attempts_left', v_res -> 'attempts_left', 'locked_until', v_res -> 'locked_until');
  end if;

  update public.user_withdrawal_pins
     set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)), updated_at = now()
   where user_id = v_uid;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason)
  values (v_uid, 'WITHDRAWAL_PIN_CHANGED', 'user_withdrawal_pins', v_uid::text, 'PIN changed with the current PIN');
  return jsonb_build_object('success', true, 'code', 'pin_changed');
end;
$$;

create or replace function public.request_withdrawal_pin_reset()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cfg public.withdrawal_pin_config;
  v_id uuid;
  v_release timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;
  if not exists (select 1 from public.user_withdrawal_pins where user_id = v_uid) then
    return jsonb_build_object('success', false, 'code', 'no_pin');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;
  v_release := now() + make_interval(hours => v_cfg.reset_cooloff_hours);

  insert into public.withdrawal_pin_resets (user_id, release_at)
  values (v_uid, v_release)
  on conflict (user_id) where status = 'pending' do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('success', false, 'code', 'already_pending');
  end if;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  values (v_uid, 'WITHDRAWAL_PIN_RESET_REQUESTED', 'withdrawal_pin_resets', v_id::text,
          'Forgot-PIN reset requested', jsonb_build_object('release_at', v_release));
  return jsonb_build_object('success', true, 'code', 'reset_requested', 'request_id', v_id, 'release_at', v_release);
end;
$$;

create or replace function public.cancel_withdrawal_pin_reset(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.withdrawal_pin_resets;
  v_staff boolean;
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;
  select * into v_row from public.withdrawal_pin_resets where id = p_request_id;
  if v_row.id is null or v_row.status <> 'pending' then
    return jsonb_build_object('success', false, 'code', 'not_pending');
  end if;

  v_staff := public.has_role(v_uid, 'financial_ops') or public.has_role(v_uid, 'cfo')
          or public.has_role(v_uid, 'super_admin') or public.has_role(v_uid, 'manager');
  if v_staff and v_row.user_id <> v_uid then
    perform public.require_staff_aal2();
  elsif v_row.user_id = v_uid then
    -- the owner cancels by proving they still know the PIN (a 'pin_change' proof)
    if not public.consume_withdrawal_pin_proof(v_uid, 'pin_change') then
      return jsonb_build_object('success', false, 'code', 'withdrawal_pin_proof_required');
    end if;
  else
    return jsonb_build_object('success', false, 'code', 'forbidden');
  end if;

  update public.withdrawal_pin_resets
     set status = 'cancelled', decided_by = v_uid, decided_at = now()
   where id = p_request_id and status = 'pending';
  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  values (v_uid, 'WITHDRAWAL_PIN_RESET_CANCELLED', 'withdrawal_pin_resets', p_request_id::text,
          'PIN reset cancelled', jsonb_build_object('account', v_row.user_id, 'by_owner', v_row.user_id = v_uid));
  return jsonb_build_object('success', true, 'code', 'reset_cancelled');
end;
$$;

create or replace function public.complete_withdrawal_pin_reset(p_new_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cfg public.withdrawal_pin_config;
  v_id uuid;
  v_release timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;
  if not public.withdrawal_pin_format_ok(p_new_pin) then
    return jsonb_build_object('success', false, 'code', 'weak_pin',
      'message', 'Choose 6 digits that are not all the same and not a run like 123456.');
  end if;
  select * into v_cfg from public.withdrawal_pin_config where id;

  update public.withdrawal_pin_resets
     set status = 'completed', decided_by = v_uid, decided_at = now()
   where user_id = v_uid and status = 'pending' and release_at <= now()
  returning id into v_id;
  if v_id is null then
    select release_at into v_release from public.withdrawal_pin_resets where user_id = v_uid and status = 'pending';
    return jsonb_build_object('success', false, 'code', 'not_ready', 'release_at', v_release);
  end if;

  update public.user_withdrawal_pins
     set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
         failed_attempts = 0, locked_until = null, updated_at = now(),
         number_change_hold_until = case when v_cfg.number_change_hold_hours > 0
                                         then now() + make_interval(hours => v_cfg.number_change_hold_hours) end
   where user_id = v_uid;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason)
  values (v_uid, 'WITHDRAWAL_PIN_RESET_COMPLETED', 'withdrawal_pin_resets', v_id::text, 'PIN reset after cooling-off');
  return jsonb_build_object('success', true, 'code', 'pin_reset');
end;
$$;

-- What the screen needs to decide what to show. Never returns the hash.
create or replace function public.my_withdrawal_pin_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_pin public.user_withdrawal_pins;
  v_mode text;
  v_reset public.withdrawal_pin_resets;
begin
  if v_uid is null then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;
  select enforce_mode into v_mode from public.withdrawal_pin_config where id;
  select * into v_pin from public.user_withdrawal_pins where user_id = v_uid;
  select * into v_reset from public.withdrawal_pin_resets where user_id = v_uid and status = 'pending';
  return jsonb_build_object(
    'success', true,
    'has_pin', v_pin.user_id is not null,
    'required', (v_mode = 'all') or (v_mode = 'pin_holders' and v_pin.user_id is not null),
    'locked_until', case when v_pin.locked_until > now() then v_pin.locked_until end,
    'number_change_hold_until', case when v_pin.number_change_hold_until > now() then v_pin.number_change_hold_until end,
    'pending_reset', case when v_reset.id is not null
                          then jsonb_build_object('id', v_reset.id, 'release_at', v_reset.release_at) end
  );
end;
$$;

-- ---------------------------------------------------------------- grants (closed by default)
revoke execute on function
  public.withdrawal_pin_format_ok(text),
  public.withdrawal_pin_check(uuid, text),
  public.consume_withdrawal_pin_proof(uuid, text),
  public.require_withdrawal_pin_proof(),
  public.verify_withdrawal_pin(text, text),
  public.set_withdrawal_pin(text, text),
  public.request_withdrawal_pin_reset(),
  public.cancel_withdrawal_pin_reset(uuid),
  public.complete_withdrawal_pin_reset(text),
  public.my_withdrawal_pin_status()
from public, anon, authenticated;

grant execute on function
  public.withdrawal_pin_format_ok(text),
  public.withdrawal_pin_check(uuid, text),
  public.consume_withdrawal_pin_proof(uuid, text),
  public.require_withdrawal_pin_proof()
to service_role;

grant execute on function
  public.verify_withdrawal_pin(text, text),
  public.set_withdrawal_pin(text, text),
  public.request_withdrawal_pin_reset(),
  public.cancel_withdrawal_pin_reset(uuid),
  public.complete_withdrawal_pin_reset(text),
  public.my_withdrawal_pin_status()
to authenticated, service_role;
