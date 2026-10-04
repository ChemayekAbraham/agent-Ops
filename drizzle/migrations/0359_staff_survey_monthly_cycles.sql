begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
  if to_regclass('public.staff_survey_responses') is null then
    raise exception 'staff_survey_responses does not exist. Apply the staff surveys migration first.';
  end if;
end $$;

-- Surveys now run in monthly cycles. A cycle opens on the 26th, Kampala time, and
-- everyone answers once per cycle.
create or replace function public.staff_survey_cycle_for(_at timestamptz)
returns date
language sql
stable
set search_path to 'public'
as $fn$
  select case
    when extract(day from (_at at time zone 'Africa/Kampala'))::int >= 26
      then (date_trunc('month', _at at time zone 'Africa/Kampala'))::date + 25
    else (date_trunc('month', _at at time zone 'Africa/Kampala') - interval '1 month')::date + 25
  end;
$fn$;

create or replace function public.staff_survey_current_cycle()
returns date
language sql
stable
set search_path to 'public'
as $fn$
  select public.staff_survey_cycle_for(now());
$fn$;

alter table public.staff_survey_responses add column if not exists cycle_start date;
alter table public.staff_survey_responses add column if not exists payout_mode text;
update public.staff_survey_responses
   set cycle_start = public.staff_survey_cycle_for(responded_at)
 where cycle_start is null;
alter table public.staff_survey_responses alter column cycle_start set not null;
alter table public.staff_survey_responses alter column cycle_start set default public.staff_survey_current_cycle();

alter table public.staff_survey_responses drop constraint if exists staff_survey_responses_uq;
alter table public.staff_survey_responses
  add constraint staff_survey_responses_uq unique (survey_id, user_id, cycle_start);
alter table public.staff_survey_responses drop constraint if exists staff_survey_responses_mode_ck;
alter table public.staff_survey_responses add constraint staff_survey_responses_mode_ck check (
  payout_mode is null
  or (response = 'pledge' and payout_mode in ('monthly_payout','monthly_compounding')));

-- The tax survey is only for people whose PAYE is currently switched off.
create or replace function public.staff_survey_paye_off()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select exists (
    select 1 from public.hr_staff st
    join public.hr_pay_statutory_profiles sp on sp.staff_id = st.id and sp.effective_to is null
    where st.user_id = auth.uid() and st.active and sp.paye_applicable = false);
$fn$;

drop function if exists public.staff_survey_pending();
create function public.staff_survey_pending()
returns table(survey_id uuid, kind text, title text, body text, snooze_count smallint,
              cycle_start date, last_response text, last_percentage smallint, last_payout_mode text)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select s.id, s.kind, s.title, s.body, coalesce(z.snooze_count, 0)::smallint,
         public.staff_survey_current_cycle(),
         prev.response, prev.percentage, prev.payout_mode
  from public.staff_surveys s
  left join public.staff_survey_snoozes z on z.survey_id = s.id and z.user_id = auth.uid()
  left join lateral (
    select r.response, r.percentage, r.payout_mode
    from public.staff_survey_responses r
    where r.survey_id = s.id and r.user_id = auth.uid()
    order by r.cycle_start desc limit 1) prev on true
  where s.active
    and auth.uid() is not null
    and public.staff_survey_is_employee()
    and not exists (select 1 from public.staff_survey_responses r
                    where r.survey_id = s.id and r.user_id = auth.uid()
                      and r.cycle_start = public.staff_survey_current_cycle())
    and (z.snooze_until is null or z.snooze_until <= now())
    and (s.kind <> 'statutory_consent' or public.staff_survey_paye_off())
  order by s.created_at
  limit 1;
$fn$;

drop function if exists public.staff_survey_respond(uuid, text, integer, text, text, boolean);
create function public.staff_survey_respond(
  _survey_id uuid, _response text, _percentage integer default null,
  _tin text default null, _nssf_number text default null, _no_tin boolean default false,
  _payout_mode text default null)
returns public.staff_survey_responses
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_kind text;
  v_active boolean;
  v_row public.staff_survey_responses%rowtype;
  v_accept boolean;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if not public.staff_survey_is_employee() then
    raise exception 'Only staff with an active employee account can answer this.';
  end if;

  select s.kind, s.active into v_kind, v_active from public.staff_surveys s where s.id = _survey_id;
  if not found then raise exception 'That survey does not exist.'; end if;
  if not v_active then raise exception 'This survey is closed.'; end if;

  if v_kind = 'statutory_consent' and _response not in ('accept','decline') then
    raise exception 'Answer Accept or Decline.';
  end if;
  if v_kind = 'reinvestment_pledge' and _response not in ('pledge','decline') then
    raise exception 'Choose a percentage or Decline.';
  end if;
  if _payout_mode is not null and _payout_mode not in ('monthly_payout','monthly_compounding') then
    raise exception 'Choose monthly returns or compounding.';
  end if;

  v_accept := (v_kind = 'statutory_consent' and _response = 'accept');
  if v_accept and not coalesce(_no_tin, false)
     and coalesce(btrim(_tin), '') !~ '^[0-9]{10}$' then
    raise exception 'Enter your 10-digit TIN, or tick that you do not have one yet.';
  end if;

  insert into public.staff_survey_responses
    (survey_id, user_id, response, percentage, tin, nssf_number, no_tin, payout_mode, cycle_start)
  values (
    _survey_id, auth.uid(), _response,
    case when _response = 'pledge' then _percentage::smallint else null end,
    case when v_accept and not coalesce(_no_tin, false) then btrim(_tin) else null end,
    case when v_accept then nullif(btrim(coalesce(_nssf_number, '')), '') else null end,
    v_accept and coalesce(_no_tin, false),
    case when _response = 'pledge' then _payout_mode else null end,
    public.staff_survey_current_cycle())
  on conflict (survey_id, user_id, cycle_start) do nothing
  returning * into v_row;

  if v_row.id is null then raise exception 'You have already answered this month.'; end if;
  delete from public.staff_survey_snoozes where survey_id = _survey_id and user_id = auth.uid();
  return v_row;
end;
$fn$;

drop function if exists public.staff_survey_results(uuid);
create function public.staff_survey_results(_survey_id uuid, _cycle date default null)
returns table(user_id uuid, full_name text, staff_ref text, department text,
              response text, percentage smallint, payout_mode text, tin text, nssf_number text,
              no_tin boolean, responded_at timestamptz, cycle_start date)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  with c as (select coalesce(_cycle, public.staff_survey_current_cycle()) as cyc),
  people as (
    select ur.user_id from public.user_roles ur where ur.role = 'employee' and ur.enabled
    union
    select r.user_id from public.staff_survey_responses r, c
     where r.survey_id = _survey_id and r.cycle_start = c.cyc
  )
  select u.user_id, p.full_name::text, s.staff_ref::text, d.name::text,
         r.response, r.percentage, r.payout_mode, r.tin, r.nssf_number,
         coalesce(r.no_tin, false), r.responded_at, (select cyc from c)
  from people u
  left join public.profiles p on p.id = u.user_id
  left join public.hr_staff s on s.user_id = u.user_id and s.active
  left join lateral (
    select dep.name from public.hr_assignments a
    join public.hr_departments dep on dep.id = a.department_id
    where a.staff_id = s.id and a.ended_on is null
    order by a.is_primary desc, a.started_on desc limit 1) d on true
  left join public.staff_survey_responses r
    on r.survey_id = _survey_id and r.user_id = u.user_id and r.cycle_start = (select cyc from c)
  where public.hr_is_admin() or public.hr_pay_is_preparer()
  order by p.full_name;
$fn$;

revoke all on function public.staff_survey_cycle_for(timestamptz) from public, anon, authenticated;
revoke all on function public.staff_survey_current_cycle() from public, anon, authenticated;
revoke all on function public.staff_survey_paye_off() from public, anon, authenticated;
revoke all on function public.staff_survey_pending() from public, anon;
revoke all on function public.staff_survey_respond(uuid, text, integer, text, text, boolean, text) from public, anon;
revoke all on function public.staff_survey_results(uuid, date) from public, anon;
grant execute on function public.staff_survey_pending() to authenticated;
grant execute on function public.staff_survey_respond(uuid, text, integer, text, text, boolean, text) to authenticated;
grant execute on function public.staff_survey_results(uuid, date) to authenticated;

update public.staff_surveys
   set body = $body$This is optional, and you will be asked again on the 26th of every month.

You can reinvest part of your salary into Welile. The percentage you choose is taken from your gross salary as shown on the payroll and deducted from your pay. It can never be more than your take-home pay after tax. Each month's amount becomes the principal of an investment portfolio earning 20% per month, on the terms already shared with staff.

Choose how you receive your return:
- Monthly withdrawable returns — your 20% is paid to your wallet every month.
- Compounding — your 20% is added to your principal every month.

Choose a percentage from 5% to 100%, then your return option — or press Decline if you do not wish to reinvest this month. Your choice applies from the next payroll that follows it.$body$
 where code = 'salary_reinvestment_2026';

commit;