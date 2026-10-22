-- Automated call centre (Africa's Talking IVR) — engine.
--
-- Robot calls, separate from the human CRM Call Centre (crm_call_sessions).
-- A campaign picks an audience and a script; the dialer (voice-autocall-dialer,
-- every minute) places calls inside the campaign's window; voice-autocall-ivr
-- answers Africa's Talking with <Say>/<GetDigits>/<Record>/<Dial> from the
-- script's steps and logs every event, key press and recording.
--
-- Access: crm, cto and super_admin ONLY. Not manager, ceo, coo, admin or any
-- ops role. crm_call_centre_authorized() is deliberately not reused — it is
-- wider. Every table is read through RLS on voice_autocall_authorized(); every
-- write goes through a SECURITY DEFINER RPC or the service role.
--
-- Every campaign, script and call carries a category:
--   tenant | partner | agent | employee | general
--
-- Hard limits enforced here, not only in the UI: calls only 08:00–19:00
-- Africa/Kampala, Monday–Saturday; anyone who pressed 9, or is paused, or is on
-- sms_opt_outs is never dialled.

-- ───────────────────────── access ─────────────────────────

create or replace function public.voice_autocall_authorized(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._has_enabled_role(_user_id, array['crm', 'cto', 'super_admin']);
$$;

-- Used by RLS and the storage policy, so signed-in users must be able to run it.
revoke all on function public.voice_autocall_authorized(uuid) from public, anon;
grant execute on function public.voice_autocall_authorized(uuid) to authenticated, service_role;

create or replace function public.voice_autocall_assert()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;
  if not public.voice_autocall_authorized(auth.uid()) then
    raise exception 'not_authorized: automated calls are limited to CRM, CTO and super admin'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.voice_autocall_assert() from public, anon, authenticated;

-- ───────────────────────── small helpers ─────────────────────────

create or replace function public.voice_autocall_e164(p_raw text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case
    when d ~ '^256[3-9][0-9]{8}$' then '+' || d
    when d ~ '^0[3-9][0-9]{8}$'   then '+256' || substr(d, 2)
    when d ~ '^[3-9][0-9]{8}$'    then '+256' || d
    else null
  end
  from (select regexp_replace(coalesce(p_raw, ''), '\D', '', 'g') as d) s;
$$;

create or replace function public.voice_autocall_mask_phone(p_phone text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case when p_phone is null or length(p_phone) < 8 then p_phone
    else left(p_phone, 7) || repeat('•', greatest(length(p_phone) - 10, 0)) || right(p_phone, 3) end;
$$;

create or replace function public.voice_autocall_first_name(p_full text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select coalesce(nullif(initcap(split_part(btrim(coalesce(p_full, '')), ' ', 1)), ''), 'there');
$$;

-- ───────────────────────── tables ─────────────────────────

create table if not exists public.voice_autocall_category_settings (
  category    text primary key check (category in ('tenant', 'partner', 'agent', 'employee', 'general')),
  paused      boolean not null default false,
  pause_reason text,
  paused_by   uuid references auth.users(id),
  paused_at   timestamptz,
  updated_at  timestamptz not null default now()
);

insert into public.voice_autocall_category_settings (category)
values ('tenant'), ('partner'), ('agent'), ('employee'), ('general')
on conflict (category) do nothing;

-- One row: is the engine alive, and is there airtime. Written by the dialer.
create table if not exists public.voice_autocall_system_status (
  id               smallint primary key default 1 check (id = 1),
  last_tick_at     timestamptz,
  last_tick_result jsonb,
  balance_amount   numeric,
  balance_currency text,
  balance_checked_at timestamptz,
  low_balance      boolean not null default false,
  configured       boolean not null default false,
  channels         integer,
  last_error       text,
  updated_at       timestamptz not null default now()
);

insert into public.voice_autocall_system_status (id) values (1) on conflict (id) do nothing;

create table if not exists public.voice_autocall_scripts (
  id          uuid primary key default gen_random_uuid(),
  code        text unique,
  category    text not null check (category in ('tenant', 'partner', 'agent', 'employee', 'general')),
  name        text not null check (length(btrim(name)) between 1 and 120),
  occasion    text not null default 'general' check (length(btrim(occasion)) between 1 and 60),
  description text,
  language    text not null default 'en',
  steps       jsonb not null,
  version     integer not null default 1,
  is_active   boolean not null default true,
  created_by  uuid references auth.users(id),
  updated_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.voice_autocall_script_versions (
  id          uuid primary key default gen_random_uuid(),
  script_id   uuid not null references public.voice_autocall_scripts(id) on delete cascade,
  version     integer not null,
  name        text not null,
  occasion    text not null,
  description text,
  steps       jsonb not null,
  saved_by    uuid references auth.users(id),
  saved_at    timestamptz not null default now(),
  unique (script_id, version)
);

create table if not exists public.voice_autocall_campaigns (
  id             uuid primary key default gen_random_uuid(),
  code           text unique,
  category       text not null check (category in ('tenant', 'partner', 'agent', 'employee', 'general')),
  name           text not null check (length(btrim(name)) between 1 and 120),
  description    text,
  script_id      uuid not null references public.voice_autocall_scripts(id),
  -- tenant_due_today | tenant_missed_yesterday | manual
  audience_kind  text not null check (audience_kind in ('tenant_due_today', 'tenant_missed_yesterday', 'manual')),
  schedule_kind  text not null check (schedule_kind in ('daily', 'once')),
  start_at       timestamptz,
  window_start   time not null,
  window_end     time not null,
  days_of_week   smallint[] not null default array[1, 2, 3, 4, 5, 6]::smallint[],
  max_attempts   smallint not null default 3 check (max_attempts between 1 and 5),
  retry_minutes  integer not null default 120 check (retry_minutes between 15 and 1440),
  record_calls   boolean not null default true,
  -- draft → active ⇄ paused → completed/archived. Seeded campaigns start paused.
  status         text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed', 'archived')),
  created_by     uuid references auth.users(id),
  updated_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint voice_autocall_window_hours check (
    window_start >= time '08:00' and window_end <= time '19:00' and window_start < window_end
  ),
  constraint voice_autocall_no_sunday check (
    cardinality(days_of_week) > 0 and days_of_week <@ array[1, 2, 3, 4, 5, 6]::smallint[]
  ),
  constraint voice_autocall_once_has_start check (schedule_kind <> 'once' or start_at is not null)
);

-- One audience build. A daily campaign gets one run per Kampala day.
create table if not exists public.voice_autocall_runs (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.voice_autocall_campaigns(id) on delete cascade,
  run_date    date not null,
  built_at    timestamptz not null default now(),
  audience_count integer not null default 0,
  skipped_count  integer not null default 0,
  expires_at  timestamptz not null,
  unique (campaign_id, run_date)
);

create table if not exists public.voice_autocall_jobs (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid references public.voice_autocall_runs(id) on delete cascade,
  campaign_id     uuid references public.voice_autocall_campaigns(id) on delete cascade,
  script_id       uuid not null references public.voice_autocall_scripts(id),
  script_version  integer not null,
  -- Frozen at enqueue so an edit mid-campaign never changes a live call.
  script_snapshot jsonb not null,
  category        text not null check (category in ('tenant', 'partner', 'agent', 'employee', 'general')),
  person_id       uuid,
  person_name     text,
  phone           text not null,
  variables       jsonb not null default '{}'::jsonb,
  is_test         boolean not null default false,
  requested_by    uuid references auth.users(id),
  -- queued → dialing → in_progress → completed | no_answer | busy | failed
  --   | cancelled | expired. Unanswered attempts go back to queued for a retry.
  status          text not null default 'queued' check (status in
                    ('queued', 'dialing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'cancelled', 'expired')),
  outcome         text,
  attempts        smallint not null default 0,
  max_attempts    smallint not null default 3,
  retry_minutes   integer not null default 120,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  expires_at      timestamptz not null,
  at_session_id   text,
  current_step    text,
  callback_count  integer not null default 0,
  answered_at     timestamptz,
  ended_at        timestamptz,
  duration_seconds integer,
  total_duration_seconds integer not null default 0,
  cost_amount     numeric,
  total_cost      numeric not null default 0,
  cost_currency   text,
  hangup_cause    text,
  record_calls    boolean not null default true,
  provider_recording_url text,
  recording_path  text,
  failure_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists voice_autocall_jobs_run_person
  on public.voice_autocall_jobs (run_id, person_id) where run_id is not null and person_id is not null;
create index if not exists voice_autocall_jobs_due
  on public.voice_autocall_jobs (next_attempt_at) where status = 'queued';
create index if not exists voice_autocall_jobs_session on public.voice_autocall_jobs (at_session_id);
create index if not exists voice_autocall_jobs_feed on public.voice_autocall_jobs (category, created_at desc);
create index if not exists voice_autocall_jobs_person on public.voice_autocall_jobs (person_id, created_at desc);

-- Raw callback log, one row per Africa's Talking post (all attempts).
create table if not exists public.voice_autocall_events (
  id            bigint generated always as identity primary key,
  job_id        uuid not null references public.voice_autocall_jobs(id) on delete cascade,
  attempt       smallint,
  at_session_id text,
  kind          text not null,
  step          text,
  payload       jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists voice_autocall_events_job on public.voice_autocall_events (job_id, id);

-- What the person did: each key press or voice message.
create table if not exists public.voice_autocall_responses (
  id             bigint generated always as identity primary key,
  job_id         uuid not null references public.voice_autocall_jobs(id) on delete cascade,
  attempt        smallint,
  step           text not null,
  digits         text,
  outcome        text,
  provider_recording_url text,
  recording_path text,
  created_at     timestamptz not null default now()
);
create index if not exists voice_autocall_responses_job on public.voice_autocall_responses (job_id, id);

-- Stop calling a person: by staff (optionally until a date / for one category)
-- or by the person pressing 9 (all categories, no end date).
create table if not exists public.voice_autocall_person_pauses (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid,
  phone       text,
  category    text check (category in ('tenant', 'partner', 'agent', 'employee', 'general')),
  reason      text not null,
  source      text not null default 'staff' check (source in ('staff', 'ivr_opt_out')),
  paused_until timestamptz,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  lifted_at   timestamptz,
  lifted_by   uuid references auth.users(id),
  constraint voice_autocall_pause_target check (person_id is not null or phone is not null)
);
create index if not exists voice_autocall_person_pauses_person
  on public.voice_autocall_person_pauses (person_id) where lifted_at is null;
create index if not exists voice_autocall_person_pauses_phone
  on public.voice_autocall_person_pauses (phone) where lifted_at is null;

-- ───────────────────────── RLS + grants ─────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'voice_autocall_category_settings', 'voice_autocall_system_status', 'voice_autocall_scripts',
    'voice_autocall_script_versions', 'voice_autocall_campaigns', 'voice_autocall_runs',
    'voice_autocall_jobs', 'voice_autocall_events', 'voice_autocall_responses',
    'voice_autocall_person_pauses'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    -- Read only for the browser; all writes go through the RPCs below.
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
    execute format('drop policy if exists voice_autocall_read on public.%I', t);
    execute format(
      'create policy voice_autocall_read on public.%I for select to authenticated using (public.voice_autocall_authorized(auth.uid()))',
      t);
  end loop;
end $$;

grant usage on sequence public.voice_autocall_events_id_seq to service_role;
grant usage on sequence public.voice_autocall_responses_id_seq to service_role;

-- ───────────────────────── recordings bucket ─────────────────────────

insert into storage.buckets (id, name, public)
values ('voice-recordings', 'voice-recordings', false)
on conflict (id) do nothing;

drop policy if exists voice_recordings_read on storage.objects;
create policy voice_recordings_read on storage.objects
  for select to authenticated
  using (bucket_id = 'voice-recordings' and public.voice_autocall_authorized(auth.uid()));

-- ───────────────────────── script validation ─────────────────────────

-- Steps shape:
-- { "voice": "woman", "start": "confirm", "steps": { "<key>": {
--     "type": "say" | "menu" | "record" | "transfer" | "hangup",
--     "say": "text with {first_name} {amount} {date} {agent_name} {message}",
--     "play_url": "https://… (optional recorded audio, e.g. Luganda)",
--     "next": "<key>",                         (say, record)
--     "options": { "1": { "next": "<key>", "outcome": "slug", "action": "opt_out" } },  (menu)
--     "no_input": { "next": "<key>", "outcome": "slug" },   (menu, record)
--     "invalid":  { "next": "<key>" },                       (menu)
--     "timeout": 10, "max_seconds": 60,
--     "outcome": "slug",                                     (any step: reaching it sets this outcome)
--     "fallback_next": "<key>"                               (transfer, when nobody picks up)
-- } } }
create or replace function public.voice_autocall_validate_steps(p_steps jsonb)
returns void
language plpgsql
immutable
set search_path to 'public'
as $$
declare
  k text;
  s jsonb;
  t text;
  opt record;
  ref text;
  steps jsonb := p_steps -> 'steps';
begin
  if jsonb_typeof(p_steps) <> 'object' or jsonb_typeof(steps) <> 'object' then
    raise exception 'invalid_script: must be an object with "start" and "steps"';
  end if;
  if (select count(*) from jsonb_object_keys(steps)) = 0 then
    raise exception 'invalid_script: no steps';
  end if;
  if (select count(*) from jsonb_object_keys(steps)) > 40 then
    raise exception 'invalid_script: at most 40 steps';
  end if;
  if not steps ? coalesce(p_steps ->> 'start', '') then
    raise exception 'invalid_script: start step "%" does not exist', p_steps ->> 'start';
  end if;
  if coalesce(p_steps ->> 'voice', 'woman') not in ('woman', 'man') then
    raise exception 'invalid_script: voice must be "woman" or "man"';
  end if;

  for k, s in select * from jsonb_each(steps) loop
    if k !~ '^[a-z0-9_]{1,40}$' then
      raise exception 'invalid_script: step key "%" must be lowercase letters, digits or _', k;
    end if;
    t := s ->> 'type';
    if t is null or t not in ('say', 'menu', 'record', 'transfer', 'hangup') then
      raise exception 'invalid_script: step "%" has unknown type "%"', k, t;
    end if;
    if t in ('say', 'menu', 'record')
       and coalesce(btrim(s ->> 'say'), '') = '' and coalesce(btrim(s ->> 'play_url'), '') = '' then
      raise exception 'invalid_script: step "%" needs "say" text or a "play_url"', k;
    end if;
    if length(coalesce(s ->> 'say', '')) > 1000 then
      raise exception 'invalid_script: step "%" text is longer than 1000 characters', k;
    end if;
    if coalesce(s ->> 'play_url', '') <> '' and (s ->> 'play_url') !~ '^https://' then
      raise exception 'invalid_script: step "%" play_url must be https', k;
    end if;
    if t in ('say', 'record') and not steps ? coalesce(s ->> 'next', '') then
      raise exception 'invalid_script: step "%" next "%" does not exist', k, s ->> 'next';
    end if;
    if t = 'transfer' and not steps ? coalesce(s ->> 'fallback_next', '') then
      raise exception 'invalid_script: transfer step "%" needs a fallback_next step', k;
    end if;
    if t = 'menu' then
      if jsonb_typeof(s -> 'options') <> 'object' or (select count(*) from jsonb_object_keys(s -> 'options')) = 0 then
        raise exception 'invalid_script: menu step "%" needs options', k;
      end if;
      for opt in select key, value from jsonb_each(s -> 'options') loop
        if opt.key !~ '^[0-9*#]$' then
          raise exception 'invalid_script: step "%" option "%" must be a single key 0-9, * or #', k, opt.key;
        end if;
        if not steps ? coalesce(opt.value ->> 'next', '') then
          raise exception 'invalid_script: step "%" option "%" next "%" does not exist', k, opt.key, opt.value ->> 'next';
        end if;
        if coalesce(opt.value ->> 'action', 'none') not in ('none', 'opt_out') then
          raise exception 'invalid_script: step "%" option "%" action must be opt_out or empty', k, opt.key;
        end if;
      end loop;
    end if;
    foreach ref in array array[s -> 'no_input' ->> 'next', s -> 'invalid' ->> 'next'] loop
      if ref is not null and not steps ? ref then
        raise exception 'invalid_script: step "%" points at missing step "%"', k, ref;
      end if;
    end loop;
    if coalesce((s ->> 'timeout')::int, 10) not between 3 and 30 then
      raise exception 'invalid_script: step "%" timeout must be 3–30 seconds', k;
    end if;
    if coalesce((s ->> 'max_seconds')::int, 60) not between 5 and 180 then
      raise exception 'invalid_script: step "%" max_seconds must be 5–180', k;
    end if;
  end loop;
end;
$$;

-- ───────────────────────── audiences ─────────────────────────

-- Today's pinned bill, less what was already collected against it today.
-- Plans funded today are absent from the pin on purpose (repayment starts
-- tomorrow), so they are never called about today.
create or replace function public.voice_autocall_audience_tenant_due_today(p_day date)
returns table (person_id uuid, phone text, person_name text, variables jsonb)
language sql
stable
security definer
set search_path to 'public'
as $$
  with bill as (
    select tenant_id, rent_request_id, agent_id, expected_ugx
    from public.agent_expected_day_plans
    where day = p_day and expected_ugx > 0 and tenant_id is not null
  ),
  paid as (
    select c.rent_request_id, sum(c.amount) as amt
    from public.agent_collections c
    where c.rent_request_id in (select rent_request_id from bill)
      and (c.created_at at time zone 'Africa/Kampala')::date = p_day
      and c.reversed_at is null
      and coalesce(c.notes, '') not ilike '%[REVERSED:%'
    group by c.rent_request_id
  ),
  per_tenant as (
    select b.tenant_id,
           sum(greatest(0, b.expected_ugx - coalesce(p.amt, 0))) as remaining,
           (array_agg(b.agent_id order by b.expected_ugx desc))[1] as agent_id
    from bill b left join paid p using (rent_request_id)
    group by b.tenant_id
    having sum(greatest(0, b.expected_ugx - coalesce(p.amt, 0))) > 0
  )
  select t.tenant_id,
         public.voice_autocall_e164(pr.phone),
         pr.full_name,
         jsonb_build_object(
           'first_name', public.voice_autocall_first_name(pr.full_name),
           'amount', to_char(round(t.remaining), 'FM999,999,999'),
           'date', to_char(p_day, 'FMDD FMMonth'),
           'agent_name', coalesce(public.voice_autocall_first_name(ag.full_name), 'your agent'))
  from per_tenant t
  join public.profiles pr on pr.id = t.tenant_id
  left join public.profiles ag on ag.id = t.agent_id
  where pr.deleted_at is null
    and coalesce(pr.is_test, false) = false
    and public.voice_autocall_e164(pr.phone) is not null;
$$;

-- Yesterday's pinned bill that was not met yesterday. A tenant who has paid
-- anything on those plans today is skipped, so nobody is told "we did not
-- receive" after they already caught up.
create or replace function public.voice_autocall_audience_tenant_missed_yesterday(p_day date)
returns table (person_id uuid, phone text, person_name text, variables jsonb)
language sql
stable
security definer
set search_path to 'public'
as $$
  with bill as (
    select tenant_id, rent_request_id, agent_id, expected_ugx
    from public.agent_expected_day_plans
    where day = p_day - 1 and expected_ugx > 0 and tenant_id is not null
  ),
  coll as (
    select c.rent_request_id, (c.created_at at time zone 'Africa/Kampala')::date as d, c.amount
    from public.agent_collections c
    where c.rent_request_id in (select rent_request_id from bill)
      and (c.created_at at time zone 'Africa/Kampala')::date in (p_day - 1, p_day)
      and c.reversed_at is null
      and coalesce(c.notes, '') not ilike '%[REVERSED:%'
  ),
  paid_y as (select rent_request_id, sum(amount) amt from coll where d = p_day - 1 group by 1),
  paid_today as (select distinct b.tenant_id from coll c join bill b using (rent_request_id) where c.d = p_day and c.amount > 0),
  per_tenant as (
    select b.tenant_id,
           sum(greatest(0, b.expected_ugx - coalesce(p.amt, 0))) as shortfall,
           (array_agg(b.agent_id order by b.expected_ugx desc))[1] as agent_id
    from bill b left join paid_y p using (rent_request_id)
    where b.tenant_id not in (select tenant_id from paid_today)
    group by b.tenant_id
    having sum(greatest(0, b.expected_ugx - coalesce(p.amt, 0))) > 0
  )
  select t.tenant_id,
         public.voice_autocall_e164(pr.phone),
         pr.full_name,
         jsonb_build_object(
           'first_name', public.voice_autocall_first_name(pr.full_name),
           'amount', to_char(round(t.shortfall), 'FM999,999,999'),
           'date', to_char(p_day - 1, 'FMDD FMMonth'),
           'agent_name', coalesce(public.voice_autocall_first_name(ag.full_name), 'your agent'))
  from per_tenant t
  join public.profiles pr on pr.id = t.tenant_id
  left join public.profiles ag on ag.id = t.agent_id
  where pr.deleted_at is null
    and coalesce(pr.is_test, false) = false
    and public.voice_autocall_e164(pr.phone) is not null;
$$;

-- Is this person (or number) blocked from automated calls in this category?
create or replace function public.voice_autocall_is_blocked(p_person uuid, p_phone text, p_category text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.voice_autocall_person_pauses pp
    where pp.lifted_at is null
      and (pp.paused_until is null or pp.paused_until > now())
      and (pp.category is null or pp.category = p_category)
      and ((p_person is not null and pp.person_id = p_person) or (p_phone is not null and pp.phone = p_phone))
  ) or exists (
    select 1 from public.sms_opt_outs o
    where p_phone is not null and public.voice_autocall_e164(o.phone) = p_phone
  );
$$;

-- ───────────────────────── engine (service role only) ─────────────────────────

create or replace function public.voice_autocall_build_run(p_campaign uuid, p_day date)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c public.voice_autocall_campaigns;
  s public.voice_autocall_scripts;
  v_run uuid;
  v_expires timestamptz;
  v_total int := 0;
  v_skipped int := 0;
begin
  select * into c from public.voice_autocall_campaigns where id = p_campaign for update;
  if not found then raise exception 'campaign_not_found'; end if;
  select * into s from public.voice_autocall_scripts where id = c.script_id;

  v_expires := case c.schedule_kind
    when 'daily' then (p_day + c.window_end) at time zone 'Africa/Kampala'
    else greatest(c.start_at, now()) + interval '3 days'
  end;

  insert into public.voice_autocall_runs (campaign_id, run_date, expires_at)
  values (c.id, p_day, v_expires)
  on conflict (campaign_id, run_date) do nothing
  returning id into v_run;
  if v_run is null then return null; end if;  -- already built

  if c.audience_kind <> 'manual' then
    with aud as (
      select a.*, public.voice_autocall_is_blocked(a.person_id, a.phone, c.category) as blocked
      from (
        select * from public.voice_autocall_audience_tenant_due_today(p_day) where c.audience_kind = 'tenant_due_today'
        union all
        select * from public.voice_autocall_audience_tenant_missed_yesterday(p_day) where c.audience_kind = 'tenant_missed_yesterday'
      ) a
    ),
    ins as (
      insert into public.voice_autocall_jobs (
        run_id, campaign_id, script_id, script_version, script_snapshot, category,
        person_id, person_name, phone, variables, max_attempts, retry_minutes,
        record_calls, expires_at)
      select v_run, c.id, s.id, s.version, s.steps, c.category,
             aud.person_id, aud.person_name, aud.phone, aud.variables, c.max_attempts, c.retry_minutes,
             c.record_calls, v_expires
      from aud where not aud.blocked
      on conflict do nothing
      returning 1
    )
    select (select count(*) from ins), (select count(*) from aud where blocked)
      into v_total, v_skipped;
  end if;

  update public.voice_autocall_runs set audience_count = v_total, skipped_count = v_skipped where id = v_run;
  return v_run;
end;
$$;

-- Turn an attempt's end into either a retry or a final status. The only place
-- that decides retries, used by the IVR's terminal callback and the stale sweep.
create or replace function public.voice_autocall_finish_attempt(
  p_job uuid,
  p_status text,           -- completed | no_answer | busy | failed
  p_duration integer default null,
  p_cost numeric default null,
  p_currency text default null,
  p_hangup_cause text default null,
  p_provider_recording_url text default null,
  p_failure_reason text default null
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  j public.voice_autocall_jobs;
  v_final text;
  v_answered boolean;
begin
  select * into j from public.voice_autocall_jobs where id = p_job for update;
  if not found then return null; end if;
  -- Duplicate terminal callbacks: absorb late facts, never rewrite the outcome.
  if j.status not in ('dialing', 'in_progress') then
    update public.voice_autocall_jobs set
      provider_recording_url = coalesce(provider_recording_url, p_provider_recording_url),
      updated_at = now()
    where id = p_job;
    return j.status;
  end if;

  v_answered := j.answered_at is not null or coalesce(p_duration, 0) > 0 and p_status = 'completed';
  v_final := case when v_answered then 'completed'
                  when p_status in ('no_answer', 'busy', 'failed') then p_status
                  else 'no_answer' end;

  if v_final <> 'completed'
     and j.attempts < j.max_attempts
     and now() + make_interval(mins => j.retry_minutes) < j.expires_at
     and not j.is_test then
    update public.voice_autocall_jobs set
      status = 'queued',
      next_attempt_at = now() + make_interval(mins => j.retry_minutes),
      hangup_cause = p_hangup_cause,
      failure_reason = p_failure_reason,
      total_cost = total_cost + coalesce(p_cost, 0),
      cost_currency = coalesce(p_currency, cost_currency),
      ended_at = now(),
      updated_at = now()
    where id = p_job;
    return 'queued';
  end if;

  update public.voice_autocall_jobs set
    status = v_final,
    outcome = coalesce(outcome, case when v_final = 'completed' then 'listened' else null end),
    duration_seconds = p_duration,
    total_duration_seconds = total_duration_seconds + coalesce(p_duration, 0),
    cost_amount = p_cost,
    total_cost = total_cost + coalesce(p_cost, 0),
    cost_currency = coalesce(p_currency, cost_currency),
    hangup_cause = p_hangup_cause,
    provider_recording_url = coalesce(p_provider_recording_url, provider_recording_url),
    failure_reason = p_failure_reason,
    ended_at = now(),
    updated_at = now()
  where id = p_job;
  return v_final;
end;
$$;

-- Each minute: build due runs, expire what can no longer be called, close stuck
-- attempts, and finish one-off campaigns that have nothing left.
create or replace function public.voice_autocall_tick()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now_local timestamp := now() at time zone 'Africa/Kampala';
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_dow int := extract(isodow from (now() at time zone 'Africa/Kampala'))::int;
  v_c record;
  v_run uuid;
  v_built int := 0;
  v_expired int := 0;
  v_stale int := 0;
  v_j record;
begin
  for v_c in
    select * from public.voice_autocall_campaigns
    where status = 'active' and audience_kind <> 'manual'
  loop
    if v_c.schedule_kind = 'daily'
       and v_dow = any (v_c.days_of_week)
       and v_now_local::time >= v_c.window_start and v_now_local::time < v_c.window_end then
      v_run := public.voice_autocall_build_run(v_c.id, v_today);
      if v_run is not null then v_built := v_built + 1; end if;
    elsif v_c.schedule_kind = 'once' and now() >= v_c.start_at
       and not exists (select 1 from public.voice_autocall_runs where campaign_id = v_c.id) then
      v_run := public.voice_autocall_build_run(v_c.id, v_today);
      if v_run is not null then v_built := v_built + 1; end if;
    end if;
  end loop;

  update public.voice_autocall_jobs set status = 'expired', updated_at = now()
  where status = 'queued' and expires_at <= now();
  get diagnostics v_expired = row_count;

  -- An attempt with no terminal callback for 15 minutes is treated as unanswered.
  for v_j in
    select id from public.voice_autocall_jobs
    where status in ('dialing', 'in_progress') and last_attempt_at < now() - interval '15 minutes'
  loop
    perform public.voice_autocall_finish_attempt(v_j.id, 'failed', null, null, null, null, null, 'no_final_callback');
    v_stale := v_stale + 1;
  end loop;

  update public.voice_autocall_campaigns c set status = 'completed', updated_at = now()
  where c.status = 'active' and c.schedule_kind = 'once'
    and exists (select 1 from public.voice_autocall_runs r where r.campaign_id = c.id)
    and not exists (
      select 1 from public.voice_autocall_jobs j
      where j.campaign_id = c.id and j.status in ('queued', 'dialing', 'in_progress'));

  return jsonb_build_object('built', v_built, 'expired', v_expired, 'stale', v_stale, 'at', now());
end;
$$;

-- Claim the next jobs to dial, never more than the free channels. Calling hours
-- are re-checked here, so a campaign edited mid-day cannot dial outside them.
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
      and not cs.paused
      and not public.voice_autocall_is_blocked(j.person_id, j.phone, j.category)
      and (
        -- Test calls (to staff only) may run 07:00–21:00 any day.
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

-- A key press or voice message. Pressing an opt-out option stops every
-- automated call to that person, in every category.
create or replace function public.voice_autocall_record_response(
  p_job uuid,
  p_step text,
  p_digits text,
  p_outcome text,
  p_action text default null,
  p_provider_recording_url text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  j public.voice_autocall_jobs;
begin
  select * into j from public.voice_autocall_jobs where id = p_job;
  if not found then return; end if;

  insert into public.voice_autocall_responses (job_id, attempt, step, digits, outcome, provider_recording_url)
  values (p_job, j.attempts, p_step, p_digits, p_outcome, p_provider_recording_url);

  if p_outcome is not null then
    update public.voice_autocall_jobs set outcome = p_outcome, updated_at = now() where id = p_job;
  end if;

  if p_action = 'opt_out' and not exists (
    select 1 from public.voice_autocall_person_pauses
    where lifted_at is null and source = 'ivr_opt_out'
      and (person_id = j.person_id or phone = j.phone)
  ) then
    insert into public.voice_autocall_person_pauses (person_id, phone, category, reason, source)
    values (j.person_id, j.phone, null, 'Pressed opt-out on an automated call', 'ivr_opt_out');
  end if;
end;
$$;

do $$
declare sig text;
begin
  foreach sig in array array[
    'public.voice_autocall_e164(text)',
    'public.voice_autocall_mask_phone(text)',
    'public.voice_autocall_first_name(text)',
    'public.voice_autocall_validate_steps(jsonb)',
    'public.voice_autocall_audience_tenant_due_today(date)',
    'public.voice_autocall_audience_tenant_missed_yesterday(date)',
    'public.voice_autocall_is_blocked(uuid, text, text)',
    'public.voice_autocall_build_run(uuid, date)',
    'public.voice_autocall_finish_attempt(uuid, text, integer, numeric, text, text, text, text)',
    'public.voice_autocall_tick()',
    'public.voice_autocall_claim(integer)',
    'public.voice_autocall_record_response(uuid, text, text, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', sig);
    execute format('grant execute on function %s to service_role', sig);
  end loop;
end $$;
