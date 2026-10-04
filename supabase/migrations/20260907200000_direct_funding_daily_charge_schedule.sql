-- Reference doc's exact daily-rounding rule (charge(day) = round(day*total/
-- term) - round((day-1)*total/term)), as a standalone, additive, read-only
-- function -- NOT a change to the live daily_repayment column.
--
-- Confirmed before writing this: rent_requests.daily_repayment is the
-- canonical, trigger-enforced (enforce_rent_request_formula) FLAT daily
-- amount (ceil(total/duration_days)) used everywhere real money moves
-- (auto-charge-wallets, arrears calculations across this whole codebase).
-- Changing that formula would touch every rent_request system-wide, not
-- just Direct/PSM-funded ones -- far too high a blast radius to justify
-- for a reporting/preview capability. This function computes the doc's
-- precise alternating-cash schedule for preview/audit purposes only; it
-- has no callers anywhere in the live collection or arrears path and
-- changes no existing behavior.

create or replace function public.direct_funding_daily_charge_schedule(
  p_total numeric,
  p_term_days integer default 30
)
returns table (day integer, cumulative_due numeric, cash_charged numeric)
language sql
immutable
as $$
  select
    d.day,
    round(p_total * d.day / greatest(1, p_term_days), 4) as cumulative_due,
    round(p_total * d.day / greatest(1, p_term_days))
      - round(p_total * (d.day - 1) / greatest(1, p_term_days)) as cash_charged
  from generate_series(1, greatest(1, p_term_days)) as d(day);
$$;

revoke all on function public.direct_funding_daily_charge_schedule(numeric, integer) from public, anon;
grant execute on function public.direct_funding_daily_charge_schedule(numeric, integer) to authenticated, service_role;
