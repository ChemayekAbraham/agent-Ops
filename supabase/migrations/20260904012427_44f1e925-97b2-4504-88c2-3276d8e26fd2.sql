CREATE OR REPLACE FUNCTION public.tppo_period_bounds(p_granularity text, p_anchor date)
 RETURNS TABLE(period_start date, period_end date)
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    case p_granularity
      when 'day'   then p_anchor
      -- weeks run Wednesday -> Tuesday
      when 'week'  then (p_anchor - (((extract(dow from p_anchor)::int + 4) % 7)))::date
      when 'month' then (date_trunc('month', p_anchor::timestamp))::date
    end as period_start,
    case p_granularity
      when 'day'   then p_anchor
      when 'week'  then (p_anchor - (((extract(dow from p_anchor)::int + 4) % 7)) + 6)::date
      when 'month' then ((date_trunc('month', p_anchor::timestamp) + interval '1 month - 1 day'))::date
    end as period_end
$function$;