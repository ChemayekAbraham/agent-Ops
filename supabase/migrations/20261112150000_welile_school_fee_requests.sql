-- Welile Schools: an agent requests a School Fees Plan on behalf of a registered student / parent.
--
-- A request is the first step of a School Fees Plan (PRD "Welile Schools PRD and Workflow"):
-- the agent picks a registered student, the term and the term fee, names the guardian who
-- repays and a guarantor, and submits. Welile ops then approves or rejects it. NO MONEY MOVES
-- here: paying the school and the ledger postings come in a later migration.
--
-- Pricing (agreed 2026-11-11, "option A"), fixed when the request is made and stored on the row:
--   plan_days  = days from today (Kampala) to 14 days before the end of term
--   daily_rate = 0.66 / (plan_days + 1)    -- facilitation fee per day on the term fee still owed
--   total_on_schedule = term_fee * 1.33    -- exactly 33% when paid on schedule
-- The browser shows the same figures from src/lib/welileSchoolsFeePlan.ts.
--
-- One open request per student (submitted or approved). Every write goes through the
-- SECURITY DEFINER function below; the table only grants SELECT to signed-in users.

create table if not exists public.welile_school_fee_requests (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references public.welile_schools(id) on delete cascade,
  profile_id         uuid not null references public.welile_school_profiles(id) on delete cascade,
  term_id            uuid references public.welile_school_terms(id) on delete set null,
  student_name       text not null,
  class_grade        text,
  term_end           date not null,
  plan_due_date      date not null,                 -- term_end - 14
  term_fee           numeric(14,2) not null check (term_fee > 0 and term_fee <= 50000000),
  plan_days          integer not null check (plan_days >= 14),
  daily_rate         numeric(12,10) not null check (daily_rate > 0),
  total_on_schedule  numeric(14,2) not null,
  guardian_name      text not null,
  guardian_phone     text not null,
  guarantor_name     text,
  guarantor_phone    text,
  note               text,
  status             text not null default 'submitted'
                     check (status in ('submitted','approved','rejected','cancelled')),
  requested_by       uuid not null,
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  review_note        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists welile_school_fee_requests_school_idx on public.welile_school_fee_requests (school_id, created_at desc);
create index if not exists welile_school_fee_requests_agent_idx on public.welile_school_fee_requests (requested_by, created_at desc);
-- One open request per student.
create unique index if not exists welile_school_fee_requests_one_open
  on public.welile_school_fee_requests (profile_id) where status in ('submitted','approved');

alter table public.welile_school_fee_requests enable row level security;

-- The requesting agent sees their own requests; Welile Schools ops see all.
drop policy if exists wsfr_select on public.welile_school_fee_requests;
create policy wsfr_select on public.welile_school_fee_requests
  for select to authenticated
  using (requested_by = (select auth.uid()) or (select public.welile_schools_ops_ok()));

-- Staff-MFA lock (doc 249).
drop policy if exists mfa_required_for_staff on public.welile_school_fee_requests;
create policy mfa_required_for_staff on public.welile_school_fee_requests
  as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

revoke all on public.welile_school_fee_requests from anon, public;
grant select on public.welile_school_fee_requests to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.welile_school_fee_requests from authenticated;
grant select, insert, update, delete on public.welile_school_fee_requests to service_role;

-- ─── Submit a request ────────────────────────────────────────────────────────
-- p_term_id: the school's term when it has one (its end date is used); otherwise p_term_end.
create or replace function public.welile_school_fee_request_submit(
  p_profile_id      uuid,
  p_term_id         uuid,
  p_term_end        date,
  p_term_fee        numeric,
  p_guardian_name   text,
  p_guardian_phone  text,
  p_guarantor_name  text,
  p_guarantor_phone text,
  p_note            text
) returns public.welile_school_fee_requests
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid     uuid := auth.uid();
  v_profile public.welile_school_profiles;
  v_end     date;
  v_due     date;
  v_today   date := (now() at time zone 'Africa/Kampala')::date;
  v_days    integer;
  v_row     public.welile_school_fee_requests;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.welile_schools_agent_ok() then raise exception 'NOT_A_SCHOOL_AGENT'; end if;

  select * into v_profile from public.welile_school_profiles where id = p_profile_id;
  if not found then raise exception 'STUDENT_NOT_FOUND'; end if;
  if v_profile.role <> 'pupil' then raise exception 'NOT_A_STUDENT'; end if;

  if p_term_id is not null then
    select t.end_date into v_end from public.welile_school_terms t
     where t.id = p_term_id and t.school_id = v_profile.school_id;
    if v_end is null then raise exception 'TERM_NOT_FOUND'; end if;
  else
    v_end := p_term_end;
  end if;
  if v_end is null then raise exception 'TERM_END_REQUIRED'; end if;

  v_due  := v_end - 14;
  v_days := v_due - v_today;
  if v_days < 14 then
    raise exception 'TERM_TOO_SHORT' using hint = 'The plan is cleared 14 days before the end of term and needs at least 14 days to run.';
  end if;
  if p_term_fee is null or p_term_fee <= 0 or p_term_fee > 50000000 then raise exception 'INVALID_TERM_FEE'; end if;
  if nullif(trim(coalesce(p_guardian_name,'')),'') is null then raise exception 'GUARDIAN_NAME_REQUIRED'; end if;
  if length(regexp_replace(coalesce(p_guardian_phone,''), '\D', '', 'g')) not between 9 and 13 then
    raise exception 'Enter a valid guardian phone number';
  end if;
  if nullif(trim(coalesce(p_guarantor_phone,'')),'') is not null
     and length(regexp_replace(p_guarantor_phone, '\D', '', 'g')) not between 9 and 13 then
    raise exception 'Enter a valid guarantor phone number';
  end if;
  if exists (select 1 from public.welile_school_fee_requests r
              where r.profile_id = p_profile_id and r.status in ('submitted','approved')) then
    raise exception 'REQUEST_ALREADY_OPEN' using hint = 'This student already has an open School Fees Plan request.';
  end if;

  insert into public.welile_school_fee_requests (
    school_id, profile_id, term_id, student_name, class_grade, term_end, plan_due_date, term_fee,
    plan_days, daily_rate, total_on_schedule, guardian_name, guardian_phone,
    guarantor_name, guarantor_phone, note, requested_by)
  values (
    v_profile.school_id, p_profile_id, p_term_id, coalesce(nullif(trim(v_profile.full_name),''), 'Student'),
    v_profile.class_grade, v_end, v_due, round(p_term_fee, 2),
    v_days, 0.66 / (v_days + 1), round(p_term_fee * 1.33, 2),
    trim(p_guardian_name), trim(p_guardian_phone),
    nullif(trim(coalesce(p_guarantor_name,'')),''), nullif(trim(coalesce(p_guarantor_phone,'')),''),
    nullif(trim(coalesce(p_note,'')),''), v_uid)
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.welile_school_fee_request_submit(uuid,uuid,date,numeric,text,text,text,text,text) from public, anon;
grant execute on function public.welile_school_fee_request_submit(uuid,uuid,date,numeric,text,text,text,text,text) to authenticated, service_role;
