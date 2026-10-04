CREATE OR REPLACE FUNCTION public.get_partner_ops_recent_withdrawals(p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_limit integer := greatest(1, least(100, coalesce(p_limit, 10)));
  v_rows jsonb;
begin
  if not (
    has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'coo') or has_role(auth.uid(), 'ceo')
    or has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'partner_ops') or has_role(auth.uid(), 'financial_ops')
    or has_role(auth.uid(), 'operations')
  ) then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(x order by x_ord desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
             'id', w.id,
             'partner_id', w.user_id,
             'partner_name', coalesce(pr.full_name, pr.email, 'Unknown partner'),
             'amount', coalesce(w.amount, 0),
             'status', w.status,
             'requested_at', w.requested_at,
             'processing_date', coalesce(w.cfo_processed_at, w.processed_at, w.coo_approved_at,
                                        w.partner_ops_approved_at, w.earliest_process_date),
             'portfolio_code', ip.portfolio_code,
             'portfolio_name', ip.account_name,
             'portfolio_id', ip.id,
             'roi_percentage', ip.roi_percentage,
             'roi_amount', case when ip.investment_amount is not null and ip.roi_percentage is not null
                                then round(ip.investment_amount * ip.roi_percentage / 100.0) end,
             'proxy_agent_name', px.proxy_name,
             'proxy_managed', px.is_managed_account
           ) as x,
           coalesce(w.cfo_processed_at, w.processed_at, w.coo_approved_at,
                    w.partner_ops_approved_at, w.requested_at) as x_ord
    from investment_withdrawal_requests w
    left join profiles pr on pr.id = w.user_id
    left join lateral (
      select p.id, p.portfolio_code, p.account_name, p.investment_amount, p.roi_percentage
      from investor_portfolios p
      where coalesce(p.investor_id, p.agent_id) = w.user_id
      order by (p.status = 'active') desc, p.investment_amount desc nulls last, p.created_at desc
      limit 1
    ) ip on true
    left join lateral (
      select coalesce(ap.full_name, ap.email) as proxy_name, a.is_managed_account
      from proxy_agent_assignments a
      left join profiles ap on ap.id = a.agent_id
      where a.beneficiary_id = w.user_id
        and a.is_active = true
        and coalesce(a.approval_status, 'approved') = 'approved'
      order by a.is_managed_account desc nulls last, a.created_at desc
      limit 1
    ) px on true
    order by x_ord desc
    limit v_limit
  ) q;

  return jsonb_build_object('rows', v_rows);
end;
$function$;

GRANT EXECUTE ON FUNCTION public.get_partner_ops_recent_withdrawals(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_partner_new_trend(p_days integer DEFAULT 1)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_days integer := greatest(1, least(400, coalesce(p_days, 1)));
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_start date := v_today - (v_days - 1);
  v_prev_start date := v_start - v_days;
  v_rows jsonb;
  v_total numeric;
  v_prev numeric;
begin
  if not (
    has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'coo') or has_role(auth.uid(), 'ceo')
    or has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'partner_ops') or has_role(auth.uid(), 'financial_ops')
    or has_role(auth.uid(), 'operations')
  ) then
    raise exception 'not authorized';
  end if;

  with partners as (
    select r.user_id, min((r.created_at at time zone 'Africa/Kampala')::date) as joined_on
    from user_roles r
    where r.role = 'supporter' and coalesce(r.enabled, true) = true
    group by r.user_id
  ),
  cal as (
    select gs::date as day from generate_series(v_start::timestamp, v_today::timestamp, interval '1 day') gs
  ),
  agg as (
    select c.day, count(p.user_id) as new_count
    from cal c
    left join partners p on p.joined_on = c.day
    group by c.day
  )
  select coalesce(jsonb_agg(jsonb_build_object('day', a.day, 'new_count', a.new_count) order by a.day), '[]'::jsonb),
         coalesce(sum(a.new_count), 0)
    into v_rows, v_total
  from agg a;

  select count(*) into v_prev
  from (
    select r.user_id, min((r.created_at at time zone 'Africa/Kampala')::date) as joined_on
    from user_roles r
    where r.role = 'supporter' and coalesce(r.enabled, true) = true
    group by r.user_id
  ) p
  where p.joined_on >= v_prev_start and p.joined_on < v_start;

  return jsonb_build_object(
    'days', v_days,
    'start', v_start,
    'end', v_today,
    'rows', v_rows,
    'total', coalesce(v_total, 0),
    'prev_total', coalesce(v_prev, 0),
    'total_partners', (select count(*) from (
        select distinct r.user_id from user_roles r
        where r.role = 'supporter' and coalesce(r.enabled, true) = true
      ) t)
  );
end;
$function$;

GRANT EXECUTE ON FUNCTION public.get_partner_new_trend(integer) TO authenticated;