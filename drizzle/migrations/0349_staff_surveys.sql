begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
end $$;

-- Staff surveys: one question per survey, shown as a blocking prompt to everyone
-- holding an enabled employee role, answered once. Written only through the
-- functions below. Answers are recorded; nothing on any payslip changes because
-- of them.
create table if not exists public.staff_surveys (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  kind        text not null,
  title       text not null,
  body        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint staff_surveys_kind_ck check (kind in ('statutory_consent','reinvestment_pledge'))
);

create table if not exists public.staff_survey_responses (
  id            uuid primary key default gen_random_uuid(),
  survey_id     uuid not null references public.staff_surveys(id) on delete cascade,
  user_id       uuid not null,
  response      text not null,
  percentage    smallint,
  tin           text,
  nssf_number   text,
  no_tin        boolean not null default false,
  responded_at  timestamptz not null default now(),
  constraint staff_survey_responses_uq unique (survey_id, user_id),
  constraint staff_survey_responses_response_ck check (response in ('accept','decline','pledge')),
  constraint staff_survey_responses_pct_ck check (
    (response = 'pledge' and percentage between 5 and 100 and percentage % 5 = 0)
    or (response <> 'pledge' and percentage is null)),
  constraint staff_survey_responses_tin_ck check (tin is null or tin ~ '^[0-9]{10}$')
);

create table if not exists public.staff_survey_snoozes (
  survey_id     uuid not null references public.staff_surveys(id) on delete cascade,
  user_id       uuid not null,
  snooze_until  timestamptz not null,
  snooze_count  smallint not null default 1,
  primary key (survey_id, user_id)
);

alter table public.staff_surveys          enable row level security;
alter table public.staff_survey_responses enable row level security;
alter table public.staff_survey_snoozes   enable row level security;

drop policy if exists staff_surveys_read on public.staff_surveys;
create policy staff_surveys_read on public.staff_surveys
  for select to authenticated using (true);

drop policy if exists staff_survey_responses_read on public.staff_survey_responses;
create policy staff_survey_responses_read on public.staff_survey_responses
  for select using (user_id = auth.uid() or public.hr_is_admin() or public.hr_pay_is_preparer());

drop policy if exists staff_survey_snoozes_read on public.staff_survey_snoozes;
create policy staff_survey_snoozes_read on public.staff_survey_snoozes
  for select using (user_id = auth.uid());

create or replace function public.staff_survey_is_employee()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select exists (select 1 from public.user_roles
                 where user_id = auth.uid() and role = 'employee' and enabled);
$fn$;

create or replace function public.staff_survey_pending()
returns table(survey_id uuid, kind text, title text, body text, snooze_count smallint)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select s.id, s.kind, s.title, s.body, coalesce(z.snooze_count, 0)::smallint
  from public.staff_surveys s
  left join public.staff_survey_snoozes z on z.survey_id = s.id and z.user_id = auth.uid()
  where s.active
    and auth.uid() is not null
    and public.staff_survey_is_employee()
    and not exists (select 1 from public.staff_survey_responses r
                    where r.survey_id = s.id and r.user_id = auth.uid())
    and (z.snooze_until is null or z.snooze_until <= now())
  order by s.created_at
  limit 1;
$fn$;

create or replace function public.staff_survey_respond(
  _survey_id uuid, _response text, _percentage integer default null,
  _tin text default null, _nssf_number text default null, _no_tin boolean default false)
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

  v_accept := (v_kind = 'statutory_consent' and _response = 'accept');
  if v_accept and not coalesce(_no_tin, false)
     and coalesce(btrim(_tin), '') !~ '^[0-9]{10}$' then
    raise exception 'Enter your 10-digit TIN, or tick that you do not have one yet.';
  end if;

  insert into public.staff_survey_responses
    (survey_id, user_id, response, percentage, tin, nssf_number, no_tin)
  values (
    _survey_id, auth.uid(), _response,
    case when _response = 'pledge' then _percentage::smallint else null end,
    case when v_accept and not coalesce(_no_tin, false) then btrim(_tin) else null end,
    case when v_accept then nullif(btrim(coalesce(_nssf_number, '')), '') else null end,
    v_accept and coalesce(_no_tin, false))
  on conflict (survey_id, user_id) do nothing
  returning * into v_row;

  if v_row.id is null then raise exception 'You have already answered this.'; end if;
  delete from public.staff_survey_snoozes where survey_id = _survey_id and user_id = auth.uid();
  return v_row;
end;
$fn$;

create or replace function public.staff_survey_snooze(_survey_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  insert into public.staff_survey_snoozes (survey_id, user_id, snooze_until, snooze_count)
  values (_survey_id, auth.uid(), now() + interval '1 day', 1)
  on conflict (survey_id, user_id) do update
    set snooze_until = now() + interval '1 day',
        snooze_count = public.staff_survey_snoozes.snooze_count + 1;
end;
$fn$;

-- Everyone who should answer, with their answer or none, for HR.
create or replace function public.staff_survey_results(_survey_id uuid)
returns table(user_id uuid, full_name text, staff_ref text, department text,
              response text, percentage smallint, tin text, nssf_number text,
              no_tin boolean, responded_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  with people as (
    select ur.user_id from public.user_roles ur where ur.role = 'employee' and ur.enabled
    union
    select r.user_id from public.staff_survey_responses r where r.survey_id = _survey_id
  )
  select u.user_id, p.full_name::text, s.staff_ref::text, d.name::text,
         r.response, r.percentage, r.tin, r.nssf_number,
         coalesce(r.no_tin, false), r.responded_at
  from people u
  left join public.profiles p on p.id = u.user_id
  left join public.hr_staff s on s.user_id = u.user_id and s.active
  left join lateral (
    select dep.name from public.hr_assignments a
    join public.hr_departments dep on dep.id = a.department_id
    where a.staff_id = s.id and a.ended_on is null
    order by a.is_primary desc, a.started_on desc limit 1) d on true
  left join public.staff_survey_responses r on r.survey_id = _survey_id and r.user_id = u.user_id
  where public.hr_is_admin() or public.hr_pay_is_preparer()
  order by p.full_name;
$fn$;

revoke all on function public.staff_survey_is_employee() from public, anon, authenticated;
revoke all on function public.staff_survey_pending() from public, anon;
revoke all on function public.staff_survey_respond(uuid, text, integer, text, text, boolean) from public, anon;
revoke all on function public.staff_survey_snooze(uuid) from public, anon;
revoke all on function public.staff_survey_results(uuid) from public, anon;
grant execute on function public.staff_survey_pending() to authenticated;
grant execute on function public.staff_survey_respond(uuid, text, integer, text, text, boolean) to authenticated;
grant execute on function public.staff_survey_snooze(uuid) to authenticated;
grant execute on function public.staff_survey_results(uuid) to authenticated;

insert into public.staff_surveys (code, kind, title, body) values
('statutory_consent_2026', 'statutory_consent', 'PAYE and NSSF on your salary',
$body$Welile will deduct Pay As You Earn (PAYE) tax and your NSSF contribution from your monthly salary and pay them on your behalf to the Uganda Revenue Authority (URA) and the National Social Security Fund (NSSF).

How PAYE is worked out each month, on your gross pay:
- Up to UGX 235,000 — no tax
- UGX 235,001 to 335,000 — 10% of the amount above 235,000
- UGX 335,001 to 410,000 — UGX 10,000 plus 20% of the amount above 335,000
- UGX 410,001 to 10,000,000 — UGX 25,000 plus 30% of the amount above 410,000
- Above UGX 10,000,000 — UGX 2,902,000 plus 40% of the amount above 10,000,000

NSSF: 5% of your gross pay is deducted as your contribution. Welile adds a further 10% of your gross pay from its own funds — that part is not taken from your salary. The full 15% is saved in your name at NSSF.

Example, on a gross salary of UGX 1,000,000:
PAYE 202,000 · NSSF 50,000 · take-home 748,000, before any other deductions. Welile also pays 100,000 into your NSSF account.

Both deductions appear on your payslip every month, and Welile pays them over by the 15th of the following month.

PAYE and NSSF are required by Ugandan law. Press Accept to confirm you understand and agree, and enter your TIN so tax can be filed in your name. Press Decline if you have concerns — this does not stop the deductions, but HR will contact you to discuss them.$body$),
('salary_reinvestment_2026', 'reinvestment_pledge', 'Reinvest part of your salary in Welile',
$body$Welile is inviting staff to reinvest part of their monthly salary back into the company.

Choose the percentage of your salary you would like to reinvest each month, from 5% up to 100%, or press Decline if you do not wish to take part.

This is a statement of interest only. Nothing will be deducted from your pay because of your answer here. Before any reinvestment begins, HR will share the full terms — how the money is invested, how returns are paid, and how you can withdraw — and ask you to sign a separate agreement.

You can change your mind at any time before you sign.$body$)
on conflict (code) do nothing;

commit;