-- Welile Schools fee requests: record the beginning of term, and start the plan then.
--
-- The agent now enters the beginning of term as well as the end (or picks a school term,
-- which has both). A plan runs from the beginning of term, or from today if the term has
-- already begun, to 14 days before the end of term:
--   plan_start = greatest(today in Kampala, term_start)
--   plan_days  = (term_end - 14) - plan_start
-- Pricing is unchanged (daily_rate = 0.66 / (plan_days + 1); total = term_fee * 1.33).
--
-- The submit function gains p_term_start, so it is dropped and re-created; the grants are
-- re-applied below (DROP FUNCTION resets them).

alter table public.welile_school_fee_requests add column if not exists term_start date;

drop function if exists public.welile_school_fee_request_submit(uuid,uuid,date,numeric,text,text,text,text,text);

create or replace function public.welile_school_fee_request_submit(
  p_profile_id      uuid,
  p_term_id         uuid,
  p_term_start      date,
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
  v_start   date;
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
    select t.start_date, t.end_date into v_start, v_end from public.welile_school_terms t
     where t.id = p_term_id and t.school_id = v_profile.school_id;
    if v_end is null then raise exception 'TERM_NOT_FOUND'; end if;
  else
    v_start := p_term_start;
    v_end   := p_term_end;
  end if;
  if v_end is null then raise exception 'TERM_END_REQUIRED'; end if;
  if v_start is null then raise exception 'TERM_START_REQUIRED'; end if;
  if v_start >= v_end then raise exception 'TERM_DATES_OUT_OF_ORDER'; end if;

  v_due  := v_end - 14;
  v_days := v_due - greatest(v_today, v_start);
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
    school_id, profile_id, term_id, student_name, class_grade, term_start, term_end, plan_due_date, term_fee,
    plan_days, daily_rate, total_on_schedule, guardian_name, guardian_phone,
    guarantor_name, guarantor_phone, note, requested_by)
  values (
    v_profile.school_id, p_profile_id, p_term_id, coalesce(nullif(trim(v_profile.full_name),''), 'Student'),
    v_profile.class_grade, v_start, v_end, v_due, round(p_term_fee, 2),
    v_days, 0.66 / (v_days + 1), round(p_term_fee * 1.33, 2),
    trim(p_guardian_name), trim(p_guardian_phone),
    nullif(trim(coalesce(p_guarantor_name,'')),''), nullif(trim(coalesce(p_guarantor_phone,'')),''),
    nullif(trim(coalesce(p_note,'')),''), v_uid)
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.welile_school_fee_request_submit(uuid,uuid,date,date,numeric,text,text,text,text,text) from public, anon;
grant execute on function public.welile_school_fee_request_submit(uuid,uuid,date,date,numeric,text,text,text,text,text) to authenticated, service_role;
