CREATE OR REPLACE FUNCTION public.get_partner_total_trend(p_preset text DEFAULT 'today')
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_preset text := lower(coalesce(p_preset, 'today'));
  v_now timestamp := (now() at time zone 'Africa/Kampala');
  v_today date := v_now::date;
  v_start timestamp;
  v_end timestamp;
  v_step interval;
  v_rows jsonb;
  v_total_partners numeric;
  v_new_in_window numeric;
  v_opening numeric;
begin
  if not (
    has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'coo') or has_role(auth.uid(), 'ceo')
    or has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'partner_ops') or has_role(auth.uid(), 'financial_ops')
    or has_role(auth.uid(), 'operations')
  ) then
    raise exception 'not authorized';
  end if;

  if v_preset = 'today' then
    v_start := v_today::timestamp; v_end := v_today::timestamp + interval '1 day' - interval '1 hour'; v_step := interval '1 hour';
  elsif v_preset = 'yesterday' then
    v_start := (v_today - 1)::timestamp; v_end := v_today::timestamp - interval '1 hour'; v_step := interval '1 hour';
  elsif v_preset = 'week' then
    v_start := (date_trunc('week', v_today)::date)::timestamp; v_end := v_today::timestamp; v_step := interval '1 day';
  elsif v_preset = 'monthly' then
    v_start := (date_trunc('month', v_today)::date)::timestamp; v_end := v_today::timestamp; v_step := interval '1 day';
  elsif v_preset = 'yearly' then
    v_start := (date_trunc('year', v_today)::date)::timestamp; v_end := (date_trunc('month', v_today)::date)::timestamp; v_step := interval '1 month';
  else
    v_start := v_today::timestamp; v_end := v_today::timestamp + interval '1 day' - interval '1 hour'; v_step := interval '1 hour';
  end if;

  with partners as (
    select r.user_id, min(r.created_at at time zone 'Africa/Kampala') as joined_at
    from user_roles r
    where r.role = 'supporter' and coalesce(r.enabled, true) = true
    group by r.user_id
  ),
  cal as (
    select gs as bucket from generate_series(v_start, v_end, v_step) gs
  ),
  agg as (
    select c.bucket,
           (select count(*) from partners p where p.joined_at >= c.bucket and p.joined_at < c.bucket + v_step) as new_count,
           (select count(*) from partners p where p.joined_at < c.bucket + v_step) as total_count
    from cal c
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'bucket', to_char(a.bucket, 'YYYY-MM-DD"T"HH24:MI:SS'),
           'new_count', a.new_count,
           'total_count', a.total_count
         ) order by a.bucket), '[]'::jsonb),
         coalesce(sum(a.new_count), 0)
    into v_rows, v_new_in_window
  from agg a;

  select count(*) into v_opening
  from (
    select r.user_id, min(r.created_at at time zone 'Africa/Kampala') as joined_at
    from user_roles r
    where r.role = 'supporter' and coalesce(r.enabled, true) = true
    group by r.user_id
  ) p
  where p.joined_at < v_start;

  select count(*) into v_total_partners
  from (
    select distinct r.user_id from user_roles r
    where r.role = 'supporter' and coalesce(r.enabled, true) = true
  ) t;

  return jsonb_build_object(
    'preset', v_preset,
    'start', v_start,
    'end', v_end,
    'granularity', case when v_step = interval '1 hour' then 'hour' when v_step = interval '1 month' then 'month' else 'day' end,
    'rows', v_rows,
    'opening_total', coalesce(v_opening, 0),
    'new_in_window', coalesce(v_new_in_window, 0),
    'total_partners', coalesce(v_total_partners, 0)
  );
end;
$function$;

GRANT EXECUTE ON FUNCTION public.get_partner_total_trend(text) TO authenticated;