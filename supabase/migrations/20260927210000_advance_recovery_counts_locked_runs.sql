
begin;

-- Fingerprint. RentFlow only: public.user_roles.enabled does not exist in welile.com.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
end $$;

-- 1. Recoveries on a LOCKED run were not counted, because only 'approved' and
--    'paid' were. Every past run ends up locked, so the recovered total always
--    read as zero and recovery would never stop. A locked run is a paid run that
--    can no longer change; its recoveries are real. Only the status list changes.
create or replace function public.hr_pay_advance_due(_staff_id uuid, _gross numeric, _run_id uuid)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select coalesce(sum(least(
           case when a.recovery_mode = 'fixed' then a.recovery_value
                else round(_gross * a.recovery_value / 100) end,
           a.principal - coalesce((select sum(r.amount)
                                   from public.hr_pay_advance_recoveries r
                                   join public.hr_pay_runs pr on pr.id = r.run_id
                                   where r.advance_id = a.id
                                     and r.run_id <> _run_id
                                     and pr.status in ('approved','paid','locked')), 0)
         )), 0)
  from public.hr_pay_advances a
  where a.staff_id = _staff_id
    and a.status = 'approved'
    and a.disbursed_at is not null
    and a.first_recovery_on <= current_date
    and a.principal > coalesce((select sum(r.amount)
                                from public.hr_pay_advance_recoveries r
                                join public.hr_pay_runs pr on pr.id = r.run_id
                                where r.advance_id = a.id
                                  and r.run_id <> _run_id
                                  and pr.status in ('approved','paid','locked')), 0);
$fn$;

-- 2. The same correction for the totals shown on screen.
create or replace function public.hr_pay_advance_recovered_totals()
returns table (advance_id uuid, recovered numeric)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select a.id,
         coalesce(sum(r.amount) filter (where pr.status in ('approved','paid','locked')), 0)::numeric
  from public.hr_pay_advances a
  left join public.hr_pay_advance_recoveries r on r.advance_id = a.id
  left join public.hr_pay_runs pr on pr.id = r.run_id
  where public.hr_pay_is_rule_reader()
     or public.hr_pay_is_preparer()
     or public.hr_pay_is_approver()
     or public.hr_pay_is_releaser()
     or public.hr_pay_is_own_staff(a.staff_id)
  group by a.id;
$fn$;

-- 3. The CFO may read an advance but not hr_staff, so names and staff refs came
--    back empty on her screen. This returns them for exactly the advances the
--    caller may already read, and nothing else. hr_staff access is unchanged.
create or replace function public.hr_pay_advance_people()
returns table (advance_id uuid, staff_ref text, full_name text)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select a.id, s.staff_ref::text, p.full_name::text
  from public.hr_pay_advances a
  join public.hr_staff s on s.id = a.staff_id
  left join public.profiles p on p.id = s.user_id
  where public.hr_pay_is_rule_reader()
     or public.hr_pay_is_preparer()
     or public.hr_pay_is_approver()
     or public.hr_pay_is_releaser()
     or public.hr_pay_is_own_staff(a.staff_id);
$fn$;

revoke all on function public.hr_pay_advance_people() from public;
revoke all on function public.hr_pay_advance_people() from anon;
grant execute on function public.hr_pay_advance_people() to authenticated;

commit;

