begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
  if to_regclass('public.staff_survey_responses') is null then
    raise exception 'staff_survey_responses does not exist. Apply the staff surveys migrations first.';
  end if;
end $$;

-- 1. The reinvestment deduction component. Inactive on purpose: it is written only by
--    the payroll calculation, and must never appear in the enrollment deduction picker,
--    where adding it by hand would deduct twice.
insert into public.hr_pay_components
  (code, name, kind, taxable, nssf_able, lst_able, is_statutory, calc_method, display_order, active, notes)
values
  ('REINVEST', 'Salary reinvestment', 'deduction', false, false, false, false, 'fixed', 95, false,
   'Written only by the payroll calculation from the employee''s latest reinvestment answer. Never enter it by hand.')
on conflict (code) do nothing;

-- 2. Each active staff member's latest reinvestment answer, for the payroll calculation.
create or replace function public.hr_pay_reinvest_pledges()
returns table(staff_id uuid, response text, percentage smallint, payout_mode text,
              responded_at timestamptz, cycle_start date)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select distinct on (st.id)
         st.id, r.response, r.percentage, r.payout_mode, r.responded_at, r.cycle_start
  from public.staff_survey_responses r
  join public.staff_surveys sv on sv.id = r.survey_id and sv.kind = 'reinvestment_pledge'
  join public.hr_staff st on st.user_id = r.user_id and st.active
  where public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()
  order by st.id, r.cycle_start desc, r.responded_at desc;
$fn$;

revoke all on function public.hr_pay_reinvest_pledges() from public, anon;
grant execute on function public.hr_pay_reinvest_pledges() to authenticated;

-- 3. Accepting salary-as-gross switches PAYE and NSSF on and records the TIN and NSSF
--    number, at the moment of acceptance. Profiles are append-only: the open row is
--    closed and a new one opened. LST is left exactly as it was.
create or replace function public.staff_survey_apply_tax_acceptance(
  _user_id uuid, _tin text, _nssf text, _at timestamptz)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_staff uuid;
  v_open public.hr_pay_statutory_profiles%rowtype;
  v_from date;
begin
  select id into v_staff from public.hr_staff where user_id = _user_id and active limit 1;
  if v_staff is null then return; end if;

  select * into v_open from public.hr_pay_statutory_profiles
   where staff_id = v_staff and effective_to is null
   order by effective_from desc limit 1;

  if v_open.id is not null and not (v_open.paye_applicable and v_open.nssf_applicable) then
    v_from := greatest(current_date, v_open.effective_from + 1);
    update public.hr_pay_statutory_profiles set effective_to = v_from where id = v_open.id;
    insert into public.hr_pay_statutory_profiles
      (staff_id, employment_type, paye_applicable, nssf_applicable, lst_applicable,
       exemption_basis, effective_from, set_by)
    values (
      v_staff, v_open.employment_type, true, true, v_open.lst_applicable,
      case when v_open.lst_applicable then null
           else 'LST not applied. PAYE and NSSF switched on after the employee accepted salary-as-gross in the staff survey on '
                || to_char(_at at time zone 'Africa/Kampala', 'DD Mon YYYY') || '.'
      end,
      v_from, _user_id);
  end if;

  if coalesce(btrim(_tin), '') <> '' or coalesce(btrim(_nssf), '') <> '' then
    insert into public.hr_pay_statutory_ids (staff_id, tin, nssf_number, updated_by, updated_at)
    values (v_staff, nullif(btrim(coalesce(_tin, '')), ''), nullif(btrim(coalesce(_nssf, '')), ''),
            _user_id, now())
    on conflict (staff_id) do update
      set tin = coalesce(excluded.tin, public.hr_pay_statutory_ids.tin),
          nssf_number = coalesce(excluded.nssf_number, public.hr_pay_statutory_ids.nssf_number),
          updated_by = excluded.updated_by,
          updated_at = now();
  end if;
end;
$fn$;

revoke all on function public.staff_survey_apply_tax_acceptance(uuid, text, text, timestamptz)
  from public, anon, authenticated;

create or replace function public.staff_survey_after_answer()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if new.response = 'accept'
     and exists (select 1 from public.staff_surveys s
                 where s.id = new.survey_id and s.kind = 'statutory_consent') then
    perform public.staff_survey_apply_tax_acceptance(new.user_id, new.tin, new.nssf_number, new.responded_at);
  end if;
  return null;
end;
$fn$;

drop trigger if exists staff_survey_after_answer_trg on public.staff_survey_responses;
create trigger staff_survey_after_answer_trg
  after insert on public.staff_survey_responses
  for each row execute function public.staff_survey_after_answer();

-- Apply it now to everyone who has already accepted.
select public.staff_survey_apply_tax_acceptance(r.user_id, r.tin, r.nssf_number, r.responded_at)
from public.staff_survey_responses r
join public.staff_surveys s on s.id = r.survey_id and s.kind = 'statutory_consent'
where r.response = 'accept';

commit;
