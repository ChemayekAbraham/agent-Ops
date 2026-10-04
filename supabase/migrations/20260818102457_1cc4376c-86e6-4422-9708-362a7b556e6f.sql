CREATE OR REPLACE FUNCTION public.get_partner_forward_schedule(p_days integer DEFAULT 30, p_streams text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_days integer := greatest(1, least(1826, coalesce(p_days, 30)));
  v_end date;
  v_streams text[] := coalesce(p_streams, array['roi_payout','compounding','promissory']);
  v_rows jsonb;
  v_totals jsonb;
begin
  if not (
    has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'coo') or has_role(auth.uid(), 'ceo')
    or has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'partner_ops') or has_role(auth.uid(), 'financial_ops')
    or has_role(auth.uid(), 'operations')
  ) then
    raise exception 'not authorized';
  end if;

  v_end := v_today + v_days - 1;

  with plans as (
    select p.id,
           coalesce(p.investor_id, p.agent_id) as owner_id,
           p.portfolio_code,
           coalesce(p.investment_amount,0) as principal,
           coalesce(p.roi_percentage,0)/100.0 as r,
           case when lower(coalesce(p.roi_mode,'')) like '%compound%' then true else false end as is_compound,
           greatest(coalesce(p.next_roi_date, v_today + 1), v_today) as first_date,
           coalesce(p.maturity_date, v_end) as end_date
    from investor_portfolios p
    where p.status = 'active' and coalesce(p.investment_amount,0) > 0
  ),
  plan_dates as (
    select pl.*,
           gs::date as due_date,
           row_number() over (partition by pl.id order by gs) as k
    from plans pl
    cross join lateral generate_series(
      pl.first_date::timestamp,
      least(v_end, pl.end_date)::timestamp,
      interval '1 month'
    ) gs
    where pl.first_date <= least(v_end, pl.end_date)
  ),
  plan_events as (
    select pd.due_date,
           case when pd.is_compound then 'compounding' else 'roi_payout' end as stream,
           coalesce(pr.full_name, pr.email, 'Unknown partner') as party,
           pd.portfolio_code as ref,
           round(case when pd.is_compound
                      then pd.principal * pd.r * power(1 + pd.r, pd.k - 1)
                      else pd.principal * pd.r end) as amount
    from plan_dates pd
    left join profiles pr on pr.id = pd.owner_id
  ),
  notes as (
    select n.id,
           coalesce(n.partner_name, 'Partner note') as party,
           coalesce(nullif(n.contribution_type,''), 'one_time') as contribution_type,
           coalesce(n.amount,0) as amount,
           greatest(0, coalesce(n.amount,0) - coalesce(n.total_collected,0)) as outstanding,
           greatest(coalesce(n.next_deduction_date, v_today + 1), v_today) as first_date
    from promissory_notes n
    where n.status in ('activated','approved','pending')
      and greatest(0, coalesce(n.amount,0) - coalesce(n.total_collected,0)) > 0
  ),
  note_dates as (
    select nt.*, gs::date as due_date,
           row_number() over (partition by nt.id order by gs) as k
    from notes nt
    cross join lateral generate_series(
      nt.first_date::timestamp,
      case when lower(nt.contribution_type) like '%month%' or lower(nt.contribution_type) like '%recur%'
           then v_end::timestamp else nt.first_date::timestamp end,
      interval '1 month'
    ) gs
    where nt.first_date <= v_end
  ),
  note_events as (
    select nd.due_date,
           'promissory'::text as stream,
           nd.party,
           'Promissory note'::text as ref,
           round(least(nd.amount, greatest(0, nd.outstanding - (nd.k - 1) * nd.amount))) as amount
    from note_dates nd
  ),
  events as (
    select * from plan_events
    union all
    select * from note_events
  ),
  filtered as (
    select * from events where amount > 0 and stream = any(v_streams)
  ),
  cal as (
    select gs::date as day from generate_series(v_today::timestamp, v_end::timestamp, interval '1 day') gs
  ),
  agg0 as (
    select c.day,
           coalesce(sum(case when f.stream = 'roi_payout' then f.amount end),0) as roi_payout,
           coalesce(sum(case when f.stream = 'compounding' then f.amount end),0) as compounding,
           coalesce(sum(case when f.stream = 'promissory' then f.amount end),0) as promissory,
           coalesce(sum(f.amount),0) as total,
           coalesce(jsonb_agg(jsonb_build_object(
             'stream', f.stream, 'party', f.party, 'ref', f.ref, 'amount', f.amount
           ) order by f.amount desc) filter (where f.amount is not null), '[]'::jsonb) as items
    from cal c
    left join filtered f on f.due_date = c.day
    group by c.day
  ),
  agg as (
    select a0.*, sum(a0.total) over (order by a0.day) as cumulative from agg0 a0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', a.day,
           'roi_payout', a.roi_payout,
           'compounding', a.compounding,
           'promissory', a.promissory,
           'total', a.total,
           'cumulative', a.cumulative,
           'items', a.items
         ) order by a.day), '[]'::jsonb)
    into v_rows
  from agg a;

  select jsonb_build_object(
    'days', v_days,
    'start', v_today,
    'end', v_end,
    'streams', to_jsonb(v_streams),
    'roi_payout', (select coalesce(sum((e->>'roi_payout')::numeric),0) from jsonb_array_elements(v_rows) e),
    'compounding', (select coalesce(sum((e->>'compounding')::numeric),0) from jsonb_array_elements(v_rows) e),
    'promissory', (select coalesce(sum((e->>'promissory')::numeric),0) from jsonb_array_elements(v_rows) e),
    'total', (select coalesce(sum((e->>'total')::numeric),0) from jsonb_array_elements(v_rows) e),
    'tomorrow', (select coalesce(e, '{}'::jsonb) from jsonb_array_elements(v_rows) e
                  where (e->>'day')::date = v_today + 1 limit 1)
  ) into v_totals;

  return jsonb_build_object('rows', v_rows, 'totals', v_totals);
end;
$function$;