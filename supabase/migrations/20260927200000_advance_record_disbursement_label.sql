begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
end $$;

-- Wording only. "Disburse and release" read as if pressing it pays the staff
-- member; it only records a payment already made. No logic changes.
create or replace function public.hr_my_approvals()
returns table(item_type text, item_id uuid, title text, detail text, raised_by uuid,
              raised_at timestamp with time zone, action_required text, route text)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select 'pay_run', r.id, 'Payroll ' || pe.code,
         'Net ' || to_char(coalesce(r.total_net,0),'FM999,999,999') ||
           case when r.rule_status_at_run='provisional' then '  ·  PROVISIONAL RULES' else '' end,
         r.prepared_by, r.prepared_at, 'Approve or return', '/hr/pay/runs/'||r.id::text
  from public.hr_pay_runs r join public.hr_pay_periods pe on pe.id=r.period_id
  where r.status='in_review' and public.hr_pay_is_approver()

  union all

  select 'pay_run', r.id, 'Payroll ' || pe.code, 'Approved, awaiting release',
         r.approved_by, r.approved_at, 'Release payment', '/hr/pay/runs/'||r.id::text
  from public.hr_pay_runs r join public.hr_pay_periods pe on pe.id=r.period_id
  where r.status='approved' and (public.hr_pay_is_releaser() or public.hr_pay_is_rule_admin())

  union all

  select 'pay_run', r.id, 'Payroll ' || pe.code || ' · ' || r.run_type,
         'Paid, awaiting lock. The period cannot close until every run in it is locked.',
         r.approved_by, r.approved_at, 'Lock', '/hr/pay/runs/'||r.id::text
  from public.hr_pay_runs r join public.hr_pay_periods pe on pe.id=r.period_id
  where r.status='paid'
    and (public.hr_pay_is_releaser() or public.hr_pay_is_approver() or public.hr_pay_is_rule_admin())

  union all

  select 'pay_run', r.id, 'Payroll ' || pe.code, 'Returned for rework',
         r.approved_by, r.approved_at, 'Correct and resubmit', '/hr/pay/runs/'||r.id::text
  from public.hr_pay_runs r join public.hr_pay_periods pe on pe.id=r.period_id
  where r.status='returned' and public.hr_pay_is_preparer()

  union all

  select 'advance', a.id, 'Salary advance · ' || s.staff_ref,
         to_char(a.principal,'FM999,999,999') || ' · ' || a.purpose,
         a.requested_by, a.requested_at, 'Approve or reject', '/hr/pay/advances'
  from public.hr_pay_advances a join public.hr_staff s on s.id=a.staff_id
  where a.status='requested' and public.hr_pay_is_approver()

  union all

  select 'advance', a.id, 'Salary advance · ' || s.staff_ref,
         to_char(a.principal,'FM999,999,999') || ' · ' || a.purpose ||
           '  ·  CEO approved. Once paid out, record the disbursement — recording sends no money.',
         a.requested_by, a.approved_at, 'Record disbursement', '/hr/pay/advances'
  from public.hr_pay_advances a join public.hr_staff s on s.id=a.staff_id
  where a.status='ceo_approved'
    and (public.hr_pay_is_releaser() or public.hr_pay_is_rule_admin())

  union all

  select 'budget_submission', s.id, 'Budget · ' || s.reference,
         d.name || ' · ' || to_char(s.total_amount, 'FM999,999,999.00'),
         s.submitted_by_user_id, s.created_at,
         'Approve or return', '/budget/submissions/'||s.id::text
  from public.budget_submissions s
  join public.hr_departments d on d.id = s.department_id
  where s.status = 'submitted' and public.budget_is_approver()

  union all

  select 'budget_submission', s.id, 'Budget · ' || s.reference,
         d.name || ' · ' || to_char(s.total_amount, 'FM999,999,999.00'),
         s.submitted_by_user_id, s.created_at,
         'Release payment', '/cfo?tab=budget-release'
  from public.budget_submissions s
  join public.hr_departments d on d.id = s.department_id
  where s.status = 'approved'
    and (public.budget_is_releaser() or public.hr_pay_is_rule_admin())

  union all

  select 'budget_submission', s.id, 'Budget · ' || s.reference,
         d.name || ' · ' || to_char(s.total_amount, 'FM999,999,999.00'),
         s.submitted_by_user_id, s.created_at,
         'Correct and resubmit', '/budget/submissions/'||s.id::text
  from public.budget_submissions s
  join public.hr_departments d on d.id = s.department_id
  where s.status = 'returned' and s.submitted_by_user_id = auth.uid();
$fn$;

commit;
