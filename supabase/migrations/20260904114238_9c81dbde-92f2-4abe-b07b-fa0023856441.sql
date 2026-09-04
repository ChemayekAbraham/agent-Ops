create or replace function public.agent_ops_collection_target(p_as_of date default null)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_asof date := coalesce(p_as_of, (now() at time zone 'Africa/Kampala')::date);
  v_out jsonb;
begin
  if not (
    has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
    or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
    or has_role(auth.uid(), 'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  with b as (
    select
      s.daily_amount,
      greatest(0,
        least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
        - s.amount_repaid
      ) as arrears,
      (s.term_start <= v_asof and s.obligation_end >= v_asof) as in_term,
      case when s.term_start <= v_asof and s.obligation_end >= v_asof
           then least(s.daily_amount * (v_asof - s.term_start + 1), s.total_amount)
              - least(s.daily_amount * (v_asof - s.term_start),     s.total_amount)
           else 0 end as scheduled_today
    from public.v_rent_plan_schedule s
  )
  select jsonb_build_object(
    'as_of',                 to_char(v_asof, 'YYYY-MM-DD'),
    'timezone',              'Africa/Kampala',
    'collectible_today',     coalesce(sum(daily_amount) filter (where arrears > 0), 0),
    'collectible_plans',     count(*) filter (where arrears > 0),
    'on_schedule_daily',     coalesce(sum(daily_amount) filter (where arrears > 0 and in_term), 0),
    'on_schedule_plans',     count(*) filter (where arrears > 0 and in_term),
    'past_term_daily',       coalesce(sum(daily_amount) filter (where arrears > 0 and not in_term), 0),
    'past_term_plans',       count(*) filter (where arrears > 0 and not in_term),
    'scheduled_today',       coalesce(sum(scheduled_today) filter (where in_term), 0),
    'scheduled_today_plans', count(*) filter (where in_term),
    'arrears_to_date',       coalesce(sum(arrears) filter (where arrears > 0), 0),
    'generated_at',          now()
  )
  into v_out
  from b;

  return v_out;
end;
$function$;

comment on function public.agent_ops_collection_target(date) is
  'Field collection target for a day. collectible_today is the daily instalment rate across every plan currently in arrears, including those past their agreed end date. This is deliberately a different figure from scheduled_today, which is only what the agreed plans schedule. The two must be presented separately, never summed or blended.';