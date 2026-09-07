alter table public.rent_requests
  add column if not exists repayment_frequency text not null default 'daily';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rent_requests_repayment_frequency_chk') then
    alter table public.rent_requests
      add constraint rent_requests_repayment_frequency_chk
      check (repayment_frequency in ('daily','weekly','monthly'));
  end if;
end $$;

comment on column public.rent_requests.repayment_frequency is
  'How often an instalment falls due: daily, weekly or monthly. Instalments are generated from repayment_starts_on at this cadence. daily_repayment remains the daily accrual rate; a weekly instalment is seven times it and a monthly instalment is one calendar month of it, each trimmed so the plan never schedules more than total_repayment.';

alter table public.rent_requests disable trigger user;

update public.rent_requests
set repayment_frequency = 'daily'
where repayment_frequency is null;

alter table public.rent_requests enable trigger user;

create or replace function public.rent_plan_schedule_days(p_from date, p_to date)
returns table (rent_request_id uuid, due_on date, amount numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  with plans as (
    select s.rent_request_id, s.daily_amount, s.total_amount,
           s.term_start, s.term_end, s.obligation_end, s.term_days,
           coalesce(rr.repayment_frequency, 'daily') as freq
    from public.v_rent_plan_schedule s
    join public.rent_requests rr on rr.id = s.rent_request_id
  ), shaped as (
    select p.*,
      case p.freq when 'weekly' then 7 when 'monthly' then 1 else 1 end as step,
      case p.freq
        when 'weekly'  then ceil(p.term_days::numeric / 7)::int
        when 'monthly' then greatest(1, ceil(p.term_days::numeric / 30))::int
        else p.term_days
      end as n_instalments,
      case p.freq
        when 'weekly'  then p.daily_amount * 7
        when 'monthly' then p.daily_amount * 30
        else p.daily_amount
      end as instalment
    from plans p
  ), expanded as (
    select s.rent_request_id, s.instalment, s.total_amount, s.obligation_end, s.freq,
           g.k,
           case s.freq
             when 'monthly' then (s.term_start + (g.k || ' month')::interval)::date
             when 'weekly'  then s.term_start + (g.k * 7)
             else s.term_start + g.k
           end as due_on
    from shaped s
    cross join lateral generate_series(0, greatest(s.n_instalments - 1, 0)) g(k)
  )
  select e.rent_request_id, e.due_on,
         (least(e.instalment * (e.k + 1), e.total_amount)
        - least(e.instalment * e.k,       e.total_amount))::numeric as amount
  from expanded e
  where e.due_on between p_from and p_to
    and e.due_on <= e.obligation_end
    and (least(e.instalment * (e.k + 1), e.total_amount)
       - least(e.instalment * e.k,       e.total_amount)) > 0;
$function$;

comment on function public.rent_plan_schedule_days(date, date) is
  'Canonical instalment generator. Returns one row per plan per due date within the range, honouring repayment_frequency. Cumulative amounts are trimmed so a plan never schedules more than total_repayment, and nothing is emitted past obligation_end. Every scheduled-rent figure in the platform must derive from this function so the arithmetic exists in one place only.';