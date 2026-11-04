-- CFO dashboard: read-only payroll history and salary-advance status.
-- Gate: cfo role, super_admin, or the payroll release-authority holder (same as cfo_staff_tax_register).
-- SECURITY DEFINER so the CFO reads through these functions only; no table policy is widened.
-- "Recovered" uses the rule in hr_pay_advance_recovered_totals(): recoveries on runs that are
-- approved, paid or locked.

create or replace function public.cfo_payroll_history()
returns table(
  run_id uuid, period_code text, period_month date, run_type text, status text,
  staff_count int, total_gross numeric, total_paye numeric, total_nssf_employee numeric,
  total_nssf_employer numeric, total_lst numeric, total_reinvest numeric,
  total_advance_recovered numeric, total_net numeric, total_employer_cost numeric,
  paid_count int, paid_amount numeric,
  prepared_by_name text, prepared_at timestamptz, approved_by_name text, approved_at timestamptz,
  paid_at timestamptz, locked_at timestamptz)
language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not (public.has_role(auth.uid(),'cfo'::app_role)
          or public.has_role(auth.uid(),'super_admin'::app_role)
          or public.hr_pay_is_releaser()) then
    raise exception 'not authorised';
  end if;

  return query
  select r.id, pe.code::text, pe.period_month::date, r.run_type::text, r.status::text,
         coalesce(ps.n, 0)::int, coalesce(ps.gross, 0), coalesce(ps.paye, 0), coalesce(ps.nssf_ee, 0),
         coalesce(ps.nssf_er, 0), coalesce(ps.lst, 0), coalesce(ln.reinvest, 0),
         coalesce(rc.recovered, 0), coalesce(ps.net, 0), coalesce(ps.cost, 0),
         coalesce(d.n, 0)::int, coalesce(d.amt, 0),
         pp.full_name, r.prepared_at, ap.full_name, r.approved_at, ev.paid_at, r.locked_at
    from hr_pay_runs r
    join hr_pay_periods pe on pe.id = r.period_id
    left join lateral (
      select count(*) n, sum(x.gross) gross, sum(x.paye) paye, sum(x.nssf_employee) nssf_ee,
             sum(x.nssf_employer) nssf_er, sum(x.lst) lst, sum(x.net) net, sum(x.employer_cost) cost
        from hr_pay_payslips x where x.run_id = r.id and x.is_current) ps on true
    left join lateral (
      select sum(l.amount) reinvest
        from hr_pay_payslip_lines l join hr_pay_payslips x on x.id = l.payslip_id
       where x.run_id = r.id and x.is_current and l.component_code = 'REINVEST') ln on true
    left join lateral (
      select sum(a.amount) recovered from hr_pay_advance_recoveries a where a.run_id = r.id) rc on true
    left join lateral (
      select count(*) n, sum(x.net) amt
        from hr_pay_disbursements dd join hr_pay_payslips x on x.id = dd.payslip_id
       where dd.run_id = r.id and dd.status = 'posted') d on true
    left join lateral (
      select min(e.created_at) paid_at from hr_pay_run_events e
       where e.run_id = r.id and e.event_type = 'paid') ev on true
    left join profiles pp on pp.id = r.prepared_by
    left join profiles ap on ap.id = r.approved_by
   order by pe.period_month desc, r.created_at desc;
end $function$;

create or replace function public.cfo_advance_status()
returns table(
  advance_id uuid, staff_ref text, full_name text, purpose text, principal numeric,
  status text, state text, requested_at timestamptz, approved_at timestamptz, disbursed_at timestamptz,
  recovery_mode text, recovery_value numeric, recovery_months int, first_recovery_on date,
  recovered numeric, balance numeric, recoveries jsonb)
language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not (public.has_role(auth.uid(),'cfo'::app_role)
          or public.has_role(auth.uid(),'super_admin'::app_role)
          or public.hr_pay_is_releaser()) then
    raise exception 'not authorised';
  end if;

  return query
  select a.id, s.staff_ref::text, p.full_name, a.purpose::text, a.principal,
         a.status::text,
         case
           when a.status::text = 'cancelled' then 'Cancelled'
           when a.principal > 0 and coalesce(rc.recovered, 0) >= a.principal then 'Repaid'
           when a.disbursed_at is null and a.status::text = 'approved' then 'Approved — not yet disbursed'
           when a.disbursed_at is null then 'Awaiting approval'
           else 'Recovering'
         end,
         a.requested_at, a.approved_at, a.disbursed_at,
         a.recovery_mode::text, a.recovery_value::numeric, a.recovery_months::int, a.first_recovery_on::date,
         coalesce(rc.recovered, 0),
         case when a.status::text = 'cancelled' then 0
              else greatest(a.principal - coalesce(rc.recovered, 0), 0) end,
         coalesce(rc.items, '[]'::jsonb)
    from hr_pay_advances a
    join hr_staff s on s.id = a.staff_id
    left join profiles p on p.id = s.user_id
    left join lateral (
      select sum(r.amount) filter (where pr.status::text in ('approved','paid','locked')) recovered,
             jsonb_agg(jsonb_build_object('period', pe.code, 'amount', r.amount,
                                          'run_status', pr.status, 'run_type', pr.run_type)
                       order by pe.period_month) items
        from hr_pay_advance_recoveries r
        join hr_pay_runs pr on pr.id = r.run_id
        join hr_pay_periods pe on pe.id = pr.period_id
       where r.advance_id = a.id) rc on true
   order by (a.status::text = 'cancelled'), a.requested_at desc;
end $function$;

revoke all on function public.cfo_payroll_history() from public, anon;
revoke all on function public.cfo_advance_status() from public, anon;
grant execute on function public.cfo_payroll_history() to authenticated;
grant execute on function public.cfo_advance_status() to authenticated;
