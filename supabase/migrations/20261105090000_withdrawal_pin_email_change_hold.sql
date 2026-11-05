-- Withdrawal PIN: a freshly changed email cannot be used to reset the PIN (doc 259 section 8, open item 5).
--
-- The hole: a forgotten-PIN reset needs only a code sent to the email on file. A person who holds a logged-in session
-- can change that email to their own inbox (email-verify-request / email-verify-confirm prove only that the NEW
-- address is theirs), then reset the PIN. Fix: when the email of a PIN holder changes, resets are refused for
-- email_change_hold_hours (default 48) and any reset already pending is cancelled. The real owner has two days to
-- notice and go to Support / Financial Ops. Set the config to 0 to switch the hold off.
--
-- Why a trigger on profiles and not an edit of email-verify-* or confirm_email_verification: the live RPC is not
-- faithfully in the repo (CLAUDE.md), and every writer of profiles.email (self-service, staff, import) is covered.
-- It fires only when the address really changes (case-insensitive) and only does work for users who have a PIN.
-- Not covered: a change made directly on auth.users without touching profiles.email; no code path does that today.

set local lock_timeout = '5s';

alter table public.withdrawal_pin_config
  add column if not exists email_change_hold_hours int not null default 48
  check (email_change_hold_hours between 0 and 168);

alter table public.user_withdrawal_pins
  add column if not exists email_changed_at timestamptz;

-- ---------------------------------------------------------------- the trigger
create or replace function public.withdrawal_pin_note_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(old.email, '')) = lower(coalesce(new.email, '')) then
    return new;
  end if;

  update public.user_withdrawal_pins
     set email_changed_at = now(), updated_at = now()
   where user_id = new.id;
  if not found then
    return new;   -- no PIN, nothing to protect
  end if;

  -- A reset started before the change was started against the old address: it dies with the change.
  update public.withdrawal_pin_resets
     set status = 'cancelled', decided_at = now(),
         decision_note = 'Cancelled automatically: the account email changed'
   where user_id = new.id and status = 'pending';

  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  values (new.id, 'WITHDRAWAL_PIN_EMAIL_CHANGED', 'user_withdrawal_pins', new.id::text,
          'Account email changed; PIN reset by email is held',
          jsonb_build_object('hold_hours', (select email_change_hold_hours from public.withdrawal_pin_config)));
  return new;
end;
$$;

drop trigger if exists trg_withdrawal_pin_note_email_change on public.profiles;
create trigger trg_withdrawal_pin_note_email_change
  after update of email on public.profiles
  for each row
  when (old.email is distinct from new.email)
  execute function public.withdrawal_pin_note_email_change();

-- ---------------------------------------------------------------- reset begin: refuse inside the hold
-- Same body as 20261104150000 plus one check. CREATE OR REPLACE keeps the grants (service_role only).
create or replace function public.pin_reset_begin(p_user uuid, p_email_usable boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.withdrawal_pin_resets;
  v_cfg public.withdrawal_pin_config;
  v_changed timestamptz;
begin
  if not exists (select 1 from public.user_withdrawal_pins where user_id = p_user) then
    return jsonb_build_object('success', false, 'code', 'no_pin');
  end if;
  -- The email code is the only proof, so without a real inbox there is nothing to check: add an email first.
  if not coalesce(p_email_usable, false) then
    return jsonb_build_object('success', false, 'code', 'no_email');
  end if;

  select * into v_cfg from public.withdrawal_pin_config where id;
  select email_changed_at into v_changed from public.user_withdrawal_pins where user_id = p_user;
  if v_changed is not null
     and v_changed + make_interval(hours => v_cfg.email_change_hold_hours) > now() then
    return jsonb_build_object('success', false, 'code', 'email_recently_changed',
      'release_at', v_changed + make_interval(hours => v_cfg.email_change_hold_hours));
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

-- The trigger function is internal: nobody calls it directly.
revoke execute on function public.withdrawal_pin_note_email_change() from public, anon, authenticated;
grant execute on function public.withdrawal_pin_note_email_change() to service_role;
