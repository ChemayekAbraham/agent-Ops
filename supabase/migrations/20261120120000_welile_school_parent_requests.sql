-- Welile Schools: a parent asks for a School Fees Plan for their child.
-- The request goes first to the Welile agent of that school's (approved) partnership. The agent
-- contacts the parent, registers the child if needed, and sends the formal fee request to Welile
-- through the existing School fees screen. No money moves here.

create table if not exists public.welile_school_parent_requests (
  id              uuid primary key default gen_random_uuid(),
  parent_id       uuid not null default auth.uid(),
  school_id       uuid not null references public.welile_schools(id) on delete cascade,
  agent_id        uuid not null,
  child_name      text not null check (length(trim(child_name)) between 2 and 120),
  class_grade     text,
  boarding_status text check (boarding_status is null or boarding_status in ('day','boarding')),
  parent_name     text not null check (length(trim(parent_name)) between 2 and 120),
  parent_phone    text not null,
  term_fee        numeric check (term_fee is null or (term_fee > 0 and term_fee <= 50000000)),
  note            text check (note is null or length(note) <= 500),
  status          text not null default 'new'
                  check (status in ('new','contacted','sent_to_welile','declined','cancelled')),
  agent_note      text check (agent_note is null or length(agent_note) <= 500),
  handled_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists welile_school_parent_requests_agent_idx  on public.welile_school_parent_requests (agent_id, status);
create index if not exists welile_school_parent_requests_parent_idx on public.welile_school_parent_requests (parent_id);
create index if not exists welile_school_parent_requests_school_idx  on public.welile_school_parent_requests (school_id);

alter table public.welile_school_parent_requests enable row level security;

-- Reads only; every write goes through the functions below. Default privileges still hand out
-- broader grants, so take those back explicitly.
revoke all on public.welile_school_parent_requests from anon;
revoke insert, update, delete, truncate, references, trigger on public.welile_school_parent_requests from authenticated;
grant select on public.welile_school_parent_requests to authenticated;
grant select, insert, update, delete on public.welile_school_parent_requests to service_role;

create policy wspr_select on public.welile_school_parent_requests for select to authenticated
  using (parent_id = (select auth.uid()) or agent_id = (select auth.uid()) or (select public.welile_schools_ops_ok()));
create policy mfa_required_for_staff on public.welile_school_parent_requests as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

-- Approved partner schools, for the parent's school picker (parents cannot read welile_schools).
create or replace function public.welile_school_partner_schools()
 returns table (id uuid, name text, school_level text, district text, town text)
 language sql stable security definer set search_path to 'public'
as $$
  select s.id, s.name, s.school_level, s.district, s.town
    from public.welile_schools s
    join public.welile_school_partnerships p on p.school_id = s.id and p.status = 'approved'
   where auth.uid() is not null
   order by s.name;
$$;

-- A parent sends a request; it is routed to the school's partnership agent.
create or replace function public.welile_school_parent_request_create(
  p_school_id uuid, p_child_name text, p_class_grade text, p_boarding_status text,
  p_parent_name text, p_parent_phone text, p_term_fee numeric, p_note text)
 returns public.welile_school_parent_requests
 language plpgsql security definer set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_agent uuid;
  v_row public.welile_school_parent_requests;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select agent_id into v_agent from public.welile_school_partnerships where school_id = p_school_id and status = 'approved';
  if v_agent is null then raise exception 'This school is not a Welile Schools partner yet'; end if;
  if length(trim(coalesce(p_child_name,''))) < 2 then raise exception 'Enter your child''s full name'; end if;
  if length(trim(coalesce(p_parent_name,''))) < 2 then raise exception 'Enter your name'; end if;
  if length(regexp_replace(coalesce(p_parent_phone,''), '\D', '', 'g')) not between 9 and 13 then
    raise exception 'Enter a valid phone number';
  end if;
  if p_boarding_status is not null and p_boarding_status not in ('day','boarding') then
    raise exception 'Choose day or boarding';
  end if;
  if (select count(*) from public.welile_school_parent_requests
       where parent_id = v_uid and status in ('new','contacted')) >= 5 then
    raise exception 'You already have 5 open requests. Wait for the agent to contact you.';
  end if;
  if exists (select 1 from public.welile_school_parent_requests
              where parent_id = v_uid and school_id = p_school_id and status in ('new','contacted')
                and lower(trim(child_name)) = lower(trim(p_child_name))) then
    raise exception 'You already asked for this child at this school. The agent will contact you.';
  end if;

  insert into public.welile_school_parent_requests
    (parent_id, school_id, agent_id, child_name, class_grade, boarding_status, parent_name, parent_phone, term_fee, note)
  values (v_uid, p_school_id, v_agent, trim(p_child_name), nullif(trim(coalesce(p_class_grade,'')),''), p_boarding_status,
          trim(p_parent_name), trim(p_parent_phone), p_term_fee, nullif(trim(coalesce(p_note,'')),''))
  returning * into v_row;
  return v_row;
end;
$$;

-- The agent (or ops) moves a request on; the parent can cancel their own while it is still new.
create or replace function public.welile_school_parent_request_update(p_id uuid, p_status text, p_note text default null)
 returns public.welile_school_parent_requests
 language plpgsql security definer set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.welile_school_parent_requests;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_row from public.welile_school_parent_requests where id = p_id for update;
  if v_row.id is null then raise exception 'REQUEST_NOT_FOUND'; end if;

  if v_row.parent_id = v_uid and v_row.agent_id <> v_uid and not public.welile_schools_ops_ok() then
    if p_status <> 'cancelled' or v_row.status <> 'new' then
      raise exception 'You can only cancel a request the agent has not started';
    end if;
  elsif v_row.agent_id = v_uid or public.welile_schools_ops_ok() then
    if p_status not in ('contacted','sent_to_welile','declined') then raise exception 'Unknown status'; end if;
    if v_row.status in ('sent_to_welile','declined','cancelled') then raise exception 'This request is already closed'; end if;
    if p_status = 'declined' and length(trim(coalesce(p_note,''))) < 3 then raise exception 'Say why it was declined'; end if;
  else
    raise exception 'NOT_ALLOWED';
  end if;

  update public.welile_school_parent_requests
     set status = p_status,
         agent_note = coalesce(nullif(trim(coalesce(p_note,'')),''), agent_note),
         handled_at = case when p_status in ('sent_to_welile','declined') then now() else handled_at end,
         updated_at = now()
   where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

-- New functions are closed by default (doc 247 step 23): open them to signed-in users; each checks the caller.
grant execute on function public.welile_school_partner_schools() to authenticated;
grant execute on function public.welile_school_parent_request_create(uuid, text, text, text, text, text, numeric, text) to authenticated;
grant execute on function public.welile_school_parent_request_update(uuid, text, text) to authenticated;
