-- Welile Schools: a school owner applies to become a partner school.
--
-- Flow:
--   1. The owner (signed in) fills the application on /schools and submits it  -> 'submitted'
--   2. Agent Ops reviews it and assigns a Welile agent to inspect the school    -> 'agent_assigned'
--      (or declines it with a reason                                            -> 'declined')
--   3. The agent visits and starts the inspection: the school record is created
--      from the application and the agent continues with the existing
--      partnership set-up (terms, fees, payout, agreement, submit for approval) -> 'inspecting'
--   The owner can withdraw while it is 'submitted' or 'agent_assigned'           -> 'withdrawn'
-- The partnership's own status (draft / submitted / approved ...) is shown to the owner through
-- welile_school_application_mine(); no money moves here.

create table if not exists public.welile_school_applications (
  id                    uuid primary key default gen_random_uuid(),
  applicant_id          uuid not null default auth.uid(),
  status                text not null default 'submitted'
                        check (status in ('submitted','agent_assigned','inspecting','declined','withdrawn')),
  -- The school
  school_name           text not null check (length(trim(school_name)) between 2 and 160),
  school_level          text not null check (length(trim(school_level)) between 2 and 60),
  ownership             text check (ownership is null or length(ownership) <= 60),
  offers                text check (offers is null or offers in ('day','boarding','day_and_boarding')),
  estimated_enrollment  integer check (estimated_enrollment is null or estimated_enrollment between 1 and 50000),
  registration_number   text check (registration_number is null or length(registration_number) <= 80),
  year_founded          integer check (year_founded is null or year_founded between 1850 and 2100),
  -- Where it is
  country               text not null default 'Uganda',
  region                text check (region is null or length(region) <= 60),
  district              text not null check (length(trim(district)) between 2 and 80),
  town                  text check (town is null or length(town) <= 120),
  village               text check (village is null or length(village) <= 120),
  directions            text check (directions is null or length(directions) <= 500),
  latitude              double precision check (latitude is null or latitude between -90 and 90),
  longitude             double precision check (longitude is null or longitude between -180 and 180),
  gps_accuracy_m        double precision,
  -- Who to talk to
  contact_name          text not null check (length(trim(contact_name)) between 2 and 120),
  contact_role          text check (contact_role is null or length(contact_role) <= 60),
  contact_phone         text not null,
  contact_email         text check (contact_email is null or length(contact_email) <= 160),
  head_name             text check (head_name is null or length(head_name) <= 120),
  head_phone            text,
  bursar_name           text check (bursar_name is null or length(bursar_name) <= 120),
  bursar_phone          text,
  note                  text check (note is null or length(note) <= 1000),
  -- Agent Ops
  assigned_agent_id     uuid,
  assigned_by           uuid,
  assigned_at           timestamptz,
  ops_note              text check (ops_note is null or length(ops_note) <= 500),
  decided_by            uuid,
  decided_at            timestamptz,
  -- The agent's inspection
  school_id             uuid references public.welile_schools(id) on delete set null,
  inspection_started_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists welile_school_applications_status_idx    on public.welile_school_applications (status, created_at desc);
create index if not exists welile_school_applications_applicant_idx on public.welile_school_applications (applicant_id);
create index if not exists welile_school_applications_agent_idx     on public.welile_school_applications (assigned_agent_id, status);

alter table public.welile_school_applications enable row level security;

-- Reads only; every write goes through the functions below. Default privileges still hand out
-- broader grants, so take those back explicitly.
revoke all on public.welile_school_applications from anon;
revoke insert, update, delete, truncate, references, trigger on public.welile_school_applications from authenticated;
grant select on public.welile_school_applications to authenticated;
grant select, insert, update, delete on public.welile_school_applications to service_role;

drop policy if exists wsa_select on public.welile_school_applications;
create policy wsa_select on public.welile_school_applications for select to authenticated
  using (applicant_id = (select auth.uid())
         or assigned_agent_id = (select auth.uid())
         or (select public.welile_schools_ops_ok()));
drop policy if exists mfa_required_for_staff on public.welile_school_applications;
create policy mfa_required_for_staff on public.welile_school_applications as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

-- ─── 1. Owner submits ────────────────────────────────────────────────────────
create or replace function public.welile_school_application_submit(p jsonb)
 returns public.welile_school_applications
 language plpgsql security definer set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.welile_school_applications;
  v_name text := trim(coalesce(p->>'school_name',''));
  v_district text := trim(coalesce(p->>'district',''));
  v_phone text := trim(coalesce(p->>'contact_phone',''));
  v_offers text := nullif(trim(coalesce(p->>'offers','')),'');
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if length(v_name) < 2 then raise exception 'Enter the school''s name'; end if;
  if length(trim(coalesce(p->>'school_level',''))) < 2 then raise exception 'Choose the school level'; end if;
  if length(v_district) < 2 then raise exception 'Choose the district'; end if;
  if length(trim(coalesce(p->>'contact_name',''))) < 2 then raise exception 'Enter your name'; end if;
  if length(regexp_replace(v_phone, '\D', '', 'g')) not between 9 and 13 then raise exception 'Enter a valid phone number'; end if;
  if v_offers is not null and v_offers not in ('day','boarding','day_and_boarding') then raise exception 'Choose day, boarding or both'; end if;
  if (select count(*) from public.welile_school_applications
       where applicant_id = v_uid and status in ('submitted','agent_assigned')) >= 3 then
    raise exception 'You already have 3 open applications. Wait for Welile to contact you.';
  end if;
  if exists (select 1 from public.welile_school_applications
              where applicant_id = v_uid and status in ('submitted','agent_assigned','inspecting')
                and lower(school_name) = lower(v_name) and lower(district) = lower(v_district)) then
    raise exception 'You have already applied for this school. Welile will contact you.';
  end if;

  insert into public.welile_school_applications (
    applicant_id, school_name, school_level, ownership, offers, estimated_enrollment, registration_number, year_founded,
    country, region, district, town, village, directions, latitude, longitude, gps_accuracy_m,
    contact_name, contact_role, contact_phone, contact_email, head_name, head_phone, bursar_name, bursar_phone, note)
  values (
    v_uid, v_name, trim(p->>'school_level'), nullif(trim(coalesce(p->>'ownership','')),''), v_offers,
    nullif(p->>'estimated_enrollment','')::integer, nullif(trim(coalesce(p->>'registration_number','')),''),
    nullif(p->>'year_founded','')::integer,
    coalesce(nullif(trim(coalesce(p->>'country','')),''), 'Uganda'), nullif(trim(coalesce(p->>'region','')),''), v_district,
    nullif(trim(coalesce(p->>'town','')),''), nullif(trim(coalesce(p->>'village','')),''), nullif(trim(coalesce(p->>'directions','')),''),
    nullif(p->>'latitude','')::double precision, nullif(p->>'longitude','')::double precision, nullif(p->>'gps_accuracy_m','')::double precision,
    trim(p->>'contact_name'), nullif(trim(coalesce(p->>'contact_role','')),''), v_phone, nullif(trim(coalesce(p->>'contact_email','')),''),
    nullif(trim(coalesce(p->>'head_name','')),''), nullif(trim(coalesce(p->>'head_phone','')),''),
    nullif(trim(coalesce(p->>'bursar_name','')),''), nullif(trim(coalesce(p->>'bursar_phone','')),''),
    nullif(trim(coalesce(p->>'note','')),''))
  returning * into v_row;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (v_uid, 'welile_school_application_submitted', 'welile_school_applications', v_row.id::text,
          jsonb_build_object('school_name', v_row.school_name, 'district', v_row.district));
  return v_row;
end;
$$;

-- ─── 2. Owner's own applications, with the partnership's progress ────────────
create or replace function public.welile_school_application_mine()
 returns table (
   id uuid, status text, school_name text, school_level text, district text, town text,
   assigned_agent_name text, assigned_agent_phone text, ops_note text,
   partnership_status text, created_at timestamptz, updated_at timestamptz)
 language sql stable security definer set search_path to 'public'
as $$
  select a.id, a.status, a.school_name, a.school_level, a.district, a.town,
         ag.full_name, ag.phone, a.ops_note,
         ps.status, a.created_at, a.updated_at
    from public.welile_school_applications a
    left join public.profiles ag on ag.id = a.assigned_agent_id
    left join public.welile_school_partnerships ps on ps.school_id = a.school_id
   where a.applicant_id = auth.uid()
   order by a.created_at desc
   limit 20;
$$;

-- ─── 3. Owner withdraws ──────────────────────────────────────────────────────
create or replace function public.welile_school_application_withdraw(p_id uuid)
 returns public.welile_school_applications
 language plpgsql security definer set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.welile_school_applications;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_row from public.welile_school_applications where id = p_id for update;
  if v_row.id is null or v_row.applicant_id <> v_uid then raise exception 'APPLICATION_NOT_FOUND'; end if;
  if v_row.status not in ('submitted','agent_assigned') then
    raise exception 'This application can no longer be withdrawn';
  end if;
  update public.welile_school_applications set status = 'withdrawn', updated_at = now()
   where id = p_id returning * into v_row;
  return v_row;
end;
$$;

-- ─── 4. Agent Ops: assign an agent, or decline ───────────────────────────────
create or replace function public.welile_school_application_review(
  p_id uuid, p_decision text, p_agent_id uuid default null, p_note text default null)
 returns public.welile_school_applications
 language plpgsql security definer set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.welile_school_applications;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.welile_schools_ops_ok() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into v_row from public.welile_school_applications where id = p_id for update;
  if v_row.id is null then raise exception 'APPLICATION_NOT_FOUND'; end if;
  if v_row.status not in ('submitted','agent_assigned') then
    raise exception 'This application is already %', v_row.status;
  end if;

  if p_decision = 'assign' then
    if p_agent_id is null then raise exception 'Choose the agent to send'; end if;
    if not public._has_enabled_role(p_agent_id, array['agent','sub_agent','senior_agent']) then
      raise exception 'That person is not an active Welile agent';
    end if;
    update public.welile_school_applications
       set status = 'agent_assigned', assigned_agent_id = p_agent_id, assigned_by = v_uid, assigned_at = now(),
           ops_note = coalesce(nullif(trim(coalesce(p_note,'')),''), ops_note), updated_at = now()
     where id = p_id returning * into v_row;
  elsif p_decision = 'decline' then
    if length(trim(coalesce(p_note,''))) < 5 then raise exception 'Give the school a reason (at least 5 characters)'; end if;
    update public.welile_school_applications
       set status = 'declined', ops_note = trim(p_note), decided_by = v_uid, decided_at = now(), updated_at = now()
     where id = p_id returning * into v_row;
  else
    raise exception 'decision must be assign or decline';
  end if;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (v_uid, 'welile_school_application_' || p_decision, 'welile_school_applications', v_row.id::text,
          jsonb_build_object('agent_id', v_row.assigned_agent_id, 'note', v_row.ops_note));
  return v_row;
end;
$$;

-- Agents Ops can pick from: active agents matching a name or phone, those already working in the
-- application's district first.
create or replace function public.welile_school_application_agent_search(p_query text, p_district text default null)
 returns table (id uuid, full_name text, phone text, schools_in_district bigint, schools_total bigint)
 language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_q text := trim(coalesce(p_query,''));
begin
  if not public.welile_schools_ops_ok() then raise exception 'NOT_AUTHORIZED'; end if;
  return query
  with candidates as (
    select pr.id, pr.full_name, pr.phone
      from public.profiles pr
     where exists (select 1 from public.user_roles ur
                    where ur.user_id = pr.id and ur.enabled and ur.role::text in ('agent','sub_agent','senior_agent'))
       and (
         (length(v_q) >= 2 and (pr.full_name ilike '%' || v_q || '%'
                                or regexp_replace(coalesce(pr.phone,''), '\D', '', 'g') like '%' || regexp_replace(v_q, '\D', '', 'g') || '%' and length(regexp_replace(v_q, '\D', '', 'g')) >= 4))
         or (length(v_q) < 2 and p_district is not null and exists (
               select 1 from public.welile_schools s where s.created_by = pr.id and lower(s.district) = lower(p_district)))
       )
     limit 200
  )
  select c.id, c.full_name, c.phone,
         (select count(*) from public.welile_schools s where s.created_by = c.id and p_district is not null and lower(s.district) = lower(p_district)),
         (select count(*) from public.welile_schools s where s.created_by = c.id)
    from candidates c
   order by 4 desc, 5 desc, c.full_name
   limit 20;
end;
$$;

-- ─── 5. The assigned agent starts the inspection ─────────────────────────────
-- Creates the school record from the application (once) and hands back the school, so the agent's
-- app can lock it and continue with the partnership set-up.
create or replace function public.welile_school_application_start_inspection(p_id uuid)
 returns public.welile_schools
 language plpgsql security definer set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_app public.welile_school_applications;
  v_school public.welile_schools;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_app from public.welile_school_applications where id = p_id for update;
  if v_app.id is null then raise exception 'APPLICATION_NOT_FOUND'; end if;
  if v_app.assigned_agent_id is distinct from v_uid and not public.welile_schools_ops_ok() then
    raise exception 'Only the agent assigned to this school can start the inspection';
  end if;
  if v_app.status not in ('agent_assigned','inspecting') then
    raise exception 'This application is %', v_app.status;
  end if;

  if v_app.school_id is not null then
    select * into v_school from public.welile_schools where id = v_app.school_id;
  end if;

  if v_school.id is null then
    insert into public.welile_schools (
      created_by, name, school_level, ownership, head_name, head_phone, estimated_enrollment,
      country, region, district, town, village, gate_name, latitude, longitude, gps_accuracy_m, gps_source)
    values (
      coalesce(v_app.assigned_agent_id, v_uid), v_app.school_name, v_app.school_level, v_app.ownership,
      coalesce(v_app.head_name, v_app.contact_name), coalesce(v_app.head_phone, v_app.contact_phone), v_app.estimated_enrollment,
      v_app.country, v_app.region, v_app.district, v_app.town, v_app.village, 'Main Gate',
      v_app.latitude, v_app.longitude, v_app.gps_accuracy_m,
      case when v_app.latitude is not null then 'owner_application' end)
    returning * into v_school;
  end if;

  update public.welile_school_applications
     set status = 'inspecting', school_id = v_school.id,
         inspection_started_at = coalesce(inspection_started_at, now()), updated_at = now()
   where id = p_id;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (v_uid, 'welile_school_application_inspection', 'welile_school_applications', p_id::text,
          jsonb_build_object('school_id', v_school.id));
  return v_school;
end;
$$;

-- New functions are closed by default (doc 247 step 23): open them to signed-in users; each checks the caller.
revoke all on function public.welile_school_application_submit(jsonb) from public, anon;
revoke all on function public.welile_school_application_mine() from public, anon;
revoke all on function public.welile_school_application_withdraw(uuid) from public, anon;
revoke all on function public.welile_school_application_review(uuid, text, uuid, text) from public, anon;
revoke all on function public.welile_school_application_agent_search(text, text) from public, anon;
revoke all on function public.welile_school_application_start_inspection(uuid) from public, anon;
grant execute on function public.welile_school_application_submit(jsonb) to authenticated, service_role;
grant execute on function public.welile_school_application_mine() to authenticated, service_role;
grant execute on function public.welile_school_application_withdraw(uuid) to authenticated, service_role;
grant execute on function public.welile_school_application_review(uuid, text, uuid, text) to authenticated, service_role;
grant execute on function public.welile_school_application_agent_search(text, text) to authenticated, service_role;
grant execute on function public.welile_school_application_start_inspection(uuid) to authenticated, service_role;
