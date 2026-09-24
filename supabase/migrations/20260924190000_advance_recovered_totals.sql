
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

-- Staff may read their own advance but not hr_pay_runs or the recovery table,
-- so a staff member's own repayment plan showed nothing repaid. This returns the
-- recovered total for exactly the advances the caller may already read under
-- the hr_pay_advances read policy, counting only approved or paid runs — the
-- same rule as hr_pay_advance_due. It exposes no run and no other person.
create or replace function public.hr_pay_advance_recovered_totals()
returns table (advance_id uuid, recovered numeric)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select a.id,
         coalesce(sum(r.amount) filter (where pr.status in ('approved','paid')), 0)::numeric
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

revoke all on function public.hr_pay_advance_recovered_totals() from public;
revoke all on function public.hr_pay_advance_recovered_totals() from anon;
grant execute on function public.hr_pay_advance_recovered_totals() to authenticated;

commit;

