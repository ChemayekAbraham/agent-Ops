-- CFO dashboard: every advance in one list, with history.
-- Sources: payroll salary advances (hr_pay_advances), staff loans (staff_requisitions,
-- request_kind = 'staff_loan') and special advances (special_advances).
-- Access: enabled 'cfo' role (CFO and Deputy CFO) or 'super_admin'.
-- Special-advance rows additionally require special_advance_cfo_ok(), the special-advances
-- module's own CFO-only rule, so this view never widens that module's access.
-- Read-only. Replaces cfo_advance_status() (unused by any screen yet) and re-gates
-- cfo_payroll_history() to the same roles.

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
  if not public._has_enabled_role(auth.uid(), array['cfo','super_admin']) then
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

drop function if exists public.cfo_advance_status();

create function public.cfo_advance_status()
returns table(
  source text, source_label text, record_id uuid, reference text,
  borrower_name text, staff_ref text, purpose text,
  principal numeric, total_repayable numeric,
  status text, state text, is_closed boolean,
  requested_at timestamptz, approved_at timestamptz, disbursed_at timestamptz,
  plan text, recovered numeric, balance numeric, repayment_tracked boolean,
  history jsonb)
language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_special boolean := public.special_advance_cfo_ok();
begin
  if not public._has_enabled_role(auth.uid(), array['cfo','super_admin']) then
    raise exception 'not authorised';
  end if;

  return query
  -- 1. Payroll salary advances: recovered = recoveries on approved/paid/locked runs
  select 'salary_advance'::text, 'Salary advance'::text, a.id, null::text,
         p.full_name, s.staff_ref::text, a.purpose::text,
         a.principal::numeric, a.principal::numeric,
         a.status::text,
         case
           when a.status::text = 'cancelled' then 'Cancelled'
           when a.principal > 0 and coalesce(rc.recovered, 0) >= a.principal then 'Repaid'
           when a.disbursed_at is null and a.status::text = 'approved' then 'Approved — not yet disbursed'
           when a.disbursed_at is null then 'Awaiting approval'
           else 'Recovering'
         end,
         (a.status::text = 'cancelled' or (a.principal > 0 and coalesce(rc.recovered, 0) >= a.principal)),
         a.requested_at, a.approved_at, a.disbursed_at,
         case when a.recovery_months is not null then a.recovery_months::text || ' month(s) from salary'
              when a.recovery_mode is not null then a.recovery_mode::text || ' ' || coalesce(a.recovery_value::text, '')
              else null end,
         coalesce(rc.recovered, 0),
         case when a.status::text = 'cancelled' then 0
              else greatest(a.principal - coalesce(rc.recovered, 0), 0) end,
         true,
         coalesce(rc.items, '[]'::jsonb)
    from hr_pay_advances a
    join hr_staff s on s.id = a.staff_id
    left join profiles p on p.id = s.user_id
    left join lateral (
      select sum(r.amount) filter (where pr.status::text in ('approved','paid','locked')) recovered,
             jsonb_agg(jsonb_build_object('label', pe.code, 'amount', r.amount,
                                          'note', 'payroll ' || pr.status::text)
                       order by pe.period_month) items
        from hr_pay_advance_recoveries r
        join hr_pay_runs pr on pr.id = r.run_id
        join hr_pay_periods pe on pe.id = pr.period_id
       where r.advance_id = a.id) rc on true

  union all

  -- 2. Staff loans requested through staff requisitions. No repayment is recorded
  --    against them anywhere yet, so recovered/balance are null and repayment_tracked = false.
  select 'staff_loan'::text, 'Staff loan'::text, q.id, q.requisition_code::text,
         coalesce(p.full_name, q.requester_name), s.staff_ref::text,
         coalesce(nullif(btrim(q.reason), ''), q.title)::text,
         coalesce(q.approved_amount, q.amount)::numeric, null::numeric,
         q.stage::text,
         case
           when q.stage::text = 'rejected' then 'Rejected'
           when q.stage::text = 'returned' then 'Returned to requester'
           when q.stage::text = 'approved' and q.wallet_credit_status::text = 'reversed' then 'Reversed'
           when q.stage::text = 'approved' and q.wallet_credit_status::text = 'credited' then 'Disbursed — repayment not tracked'
           when q.stage::text = 'approved' then 'Approved — not yet disbursed'
           else 'Awaiting approval (' || q.stage::text || ')'
         end,
         q.stage::text in ('rejected','returned') or q.wallet_credit_status::text = 'reversed',
         q.created_at, coalesce(q.decided_at, q.ceo_decided_at, q.cfo_decided_at), q.credited_at,
         case when q.loan_months is not null
              then q.loan_months::text || ' month(s)'
                   || coalesce(' at ' || q.loan_monthly_rate::text || '% a month', '')
              else null end,
         null::numeric, null::numeric, false,
         '[]'::jsonb
    from staff_requisitions q
    left join profiles p on p.id = q.requester_id
    left join hr_staff s on s.user_id = q.requester_id
   where q.request_kind::text = 'staff_loan'

  union all

  -- 3. Special advances, only for callers the special-advances module itself admits.
  select 'special_advance'::text, 'Special advance'::text, sa.id, sa.reference::text,
         coalesce(p.full_name, eb.full_name), s.staff_ref::text, sa.purpose::text,
         sa.principal::numeric, sa.total_repayable::numeric,
         sa.status::text,
         case sa.status::text
           when 'pending_approval' then 'Awaiting approval'
           when 'approved' then 'Approved — not yet disbursed'
           when 'disbursed' then 'Recovering'
           when 'settled' then 'Repaid'
           when 'rejected' then 'Rejected'
           when 'cancelled' then 'Cancelled'
           when 'reversed' then 'Reversed'
           when 'written_off' then 'Written off'
           else sa.status::text
         end,
         sa.status::text in ('settled','rejected','cancelled','reversed','written_off'),
         sa.created_at, sa.approved_at, sa.disbursed_at,
         sa.instalments::text || ' × ' || sa.instalment_amount::text || ' ' || sa.frequency::text,
         coalesce(rp.repaid, 0),
         case when sa.status::text = 'disbursed'
              then greatest(sa.total_repayable::numeric - coalesce(rp.repaid, 0), 0)
              else 0 end,
         true,
         coalesce(rp.items, '[]'::jsonb)
    from special_advances sa
    left join profiles p on p.id = sa.borrower_user_id
    left join hr_staff s on s.user_id = sa.borrower_user_id
    left join special_advance_external_borrowers eb on eb.id = sa.external_borrower_id
    left join lateral (
      select sum(x.amount) repaid,
             jsonb_agg(jsonb_build_object('label', x.received_date::text, 'amount', x.amount,
                                          'note', x.method::text) order by x.received_date) items
        from special_advance_repayments x
       where x.advance_id = sa.id and x.reversed_by_correction is null) rp on true
   where v_special

   order by 12, 13 desc;  -- open first, newest first
end $function$;

revoke all on function public.cfo_payroll_history() from public, anon;
revoke all on function public.cfo_advance_status() from public, anon;
grant execute on function public.cfo_payroll_history() to authenticated;
grant execute on function public.cfo_advance_status() to authenticated;
