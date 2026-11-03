-- One phone line, two users: the automated call centre and staff calling
-- from the app (CRM Call Centre, Tenant Ops, Landlord Ops).
--
-- Replaces the blanket "human calling paused" switch with a live rule:
--   * The line is the ROBOT's while a robot call is live, or a running
--     campaign is inside its window with people still waiting (it dials again
--     within a minute), or a test call is waiting to dial.
--   * The line is STAFF's while a staff call is live (ringing / bridged /
--     active, under 30 min old) or was reserved in the last 2 minutes and is
--     still being set up.
--   * Staff can call only while the robot does not have the line; they are
--     told "This line is in use by automated calls right now. Try again after
--     HH:MM." The robot waits while a staff call is on.
--
-- Race safety: every hand-over goes through one transaction-scoped advisory
-- lock, voice_line. voice_line_try_staff() (crm-place-call, the voice token,
-- and crm-voice-callback just before it bridges) and voice_autocall_claim()
-- (the dialer) both take it, so they can never both decide the line is free.
-- A staff reservation lasts 2 minutes, covering the gap between "allowed" and
-- the call session row becoming live.
--
-- human_calling_paused stays as a manual override (crm/cto/super_admin) and
-- is switched OFF here, as asked: staff may call whenever the robot is idle.

alter table public.voice_autocall_system_status
  add column if not exists staff_reserved_until timestamptz;

update public.voice_autocall_system_status set
  human_calling_paused = false,
  human_calling_pause_reason = null,
  human_calling_paused_at = null,
  human_calling_paused_by = null,
  updated_at = now()
where id = 1;

-- ───────────────────────── line facts ─────────────────────────

-- Does the robot have the line right now? until = when its current window ends.
create or replace function public.voice_line_robot_state()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with k as (
    select now() at time zone 'Africa/Kampala' as t,
           extract(isodow from (now() at time zone 'Africa/Kampala'))::int as dow
  ),
  live as (
    select count(*) as n from public.voice_autocall_jobs where status in ('dialing', 'in_progress')
  ),
  windows as (
    select c.id, c.window_end
    from public.voice_autocall_campaigns c
    join public.voice_autocall_category_settings cs on cs.category = c.category
    cross join k
    where c.status = 'active' and not cs.paused
      and k.dow between 1 and 6 and k.dow = any (c.days_of_week)
      and k.t::time >= greatest(c.window_start, time '08:00')
      and k.t::time < least(c.window_end, time '19:00')
      and exists (
        select 1 from public.voice_autocall_jobs j
        where j.campaign_id = c.id and j.status = 'queued' and j.expires_at > now()
      )
  ),
  tests as (
    select count(*) as n from public.voice_autocall_jobs j, k
    where j.is_test and j.status = 'queued' and j.expires_at > now()
      and k.t::time between time '07:00' and time '21:00'
  )
  select jsonb_build_object(
    'busy', (select n from live) > 0 or exists (select 1 from windows) or (select n from tests) > 0,
    'live_calls', (select n from live),
    'campaign_window_open', exists (select 1 from windows),
    'test_waiting', (select n from tests) > 0,
    'until', (select to_char(max(least(window_end, time '19:00')), 'HH24:MI') from windows)
  );
$$;

-- Does staff have the line right now?
create or replace function public.voice_line_staff_busy()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.crm_call_sessions s
    where s.ended_at is null
      and s.status in ('initiating', 'ringing_staff', 'ringing', 'bridged', 'active')
      and s.created_at > now() - interval '30 minutes'
  ) or coalesce((select staff_reserved_until > now() from public.voice_autocall_system_status where id = 1), false);
$$;

-- Ask to use the line for a staff call. Takes the line lock; on success
-- reserves it for 2 minutes. Called by the edge functions (service role).
-- p_bridging: the staff call was already allowed and is now being connected
-- (crm-voice-callback). Only a robot call that is actually live refuses it;
-- a campaign window that opened in the meantime must not cut it off.
create or replace function public.voice_line_try_staff(p_bridging boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_sys public.voice_autocall_system_status;
  v_robot jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('voice_line'));

  select * into v_sys from public.voice_autocall_system_status where id = 1;
  if coalesce(v_sys.human_calling_paused, false) then
    return jsonb_build_object('ok', false, 'reason', 'paused',
      'message', 'Calling from the app is paused by an administrator.');
  end if;

  v_robot := public.voice_line_robot_state();
  if (case when p_bridging then (v_robot ->> 'live_calls')::int > 0 else (v_robot ->> 'busy')::boolean end) then
    return jsonb_build_object('ok', false, 'reason', 'robot_busy', 'until', v_robot ->> 'until',
      'message', 'This line is in use by automated calls right now.'
        || case when v_robot ->> 'until' is not null then ' Try again after ' || (v_robot ->> 'until') || '.'
                else ' Try again in a few minutes.' end);
  end if;

  update public.voice_autocall_system_status
  set staff_reserved_until = greatest(coalesce(staff_reserved_until, now()), now() + interval '2 minutes')
  where id = 1;
  return jsonb_build_object('ok', true);
end;
$$;

-- What the screens show. "paused" = staff cannot call right now (manual
-- override or the robot has the line); the screens hide their call buttons.
create or replace function public.crm_human_calling_paused()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with s as (select * from public.voice_autocall_system_status where id = 1),
       r as (select public.voice_line_robot_state() as v)
  select case
    when coalesce(s.human_calling_paused, false) then jsonb_build_object(
      'paused', true, 'state', 'paused', 'until', null,
      'reason', coalesce(s.human_calling_pause_reason, 'Calling from the app is paused by an administrator.'),
      'paused_at', s.human_calling_paused_at)
    when (r.v ->> 'busy')::boolean then jsonb_build_object(
      'paused', true, 'state', 'robot', 'until', r.v ->> 'until',
      'reason', 'This line is in use by automated calls right now.'
        || case when r.v ->> 'until' is not null then ' Try again after ' || (r.v ->> 'until') || '.' else '' end,
      'paused_at', null)
    else jsonb_build_object('paused', false, 'state', 'idle', 'until', null, 'reason', null, 'paused_at', null)
  end
  from s, r;
$$;

revoke all on function public.voice_line_robot_state() from public, anon, authenticated;
revoke all on function public.voice_line_staff_busy() from public, anon, authenticated;
revoke all on function public.voice_line_try_staff(boolean) from public, anon, authenticated;
grant execute on function public.voice_line_robot_state() to service_role;
grant execute on function public.voice_line_staff_busy() to service_role;
grant execute on function public.voice_line_try_staff(boolean) to service_role;
revoke all on function public.crm_human_calling_paused() from public, anon;
grant execute on function public.crm_human_calling_paused() to authenticated, service_role;

-- ───────────────────────── the dialer waits for staff ─────────────────────────

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
  -- Same lock as voice_line_try_staff: staff and robot never both take the line.
  perform pg_advisory_xact_lock(hashtext('voice_line'));
  if public.voice_line_staff_busy() then return; end if;

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
