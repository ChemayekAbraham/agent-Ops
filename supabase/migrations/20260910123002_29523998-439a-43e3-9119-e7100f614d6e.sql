create or replace function public.get_unregistered_recipient_transfers_summary(
  p_days integer default 120
)
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_total numeric := 0;
  v_count integer := 0;
begin
  if not (
    public.has_role(auth.uid(), 'cfo') or public.has_role(auth.uid(), 'coo')
    or public.has_role(auth.uid(), 'manager') or public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'operations') or public.has_role(auth.uid(), 'financial_ops')
  ) then
    raise exception 'not_authorized';
  end if;

  with desk_phones as (
    select right(regexp_replace(x, '\D', '', 'g'), 9) as p9,
           bool_or(ca.is_active) as any_active
    from public.cashout_agents ca,
         unnest(array[coalesce(ca.float_phone,''), coalesce(ca.personal_phone,'')]) as x
    where length(regexp_replace(x, '\D', '', 'g')) >= 9
    group by 1
  ), emails as (
    select gt.id, gt.amount,
           coalesce(
             nullif(right(regexp_replace(coalesce(gt.counterparty, ''), '\D', '', 'g'), 9), ''),
             nullif(right(regexp_replace(coalesce(substring(gt.snippet from 'Mobile Number: *([0-9]{9,13})'), ''), '\D', '', 'g'), 9), ''),
             nullif(right(regexp_replace(coalesce(substring(gt.snippet from 'to [^,]+, *([0-9]{9,13})'), ''), '\D', '', 'g'), 9), '')
           ) as p9
    from public.gmail_transactions gt
    where gt.channel in ('mtn_momo', 'airtel_money')
      and gt.direction = 'out'
      and gt.amount is not null
      and coalesce(gt.internal_date, gt.created_at) >= now() - (greatest(coalesce(p_days, 120), 1) || ' days')::interval
  )
  select coalesce(sum(e.amount), 0), count(*)
  into v_total, v_count
  from emails e
  left join desk_phones d on d.p9 = e.p9
  where e.p9 is null or d.p9 is null or d.any_active is not true;

  return json_build_object(
    'total', v_total,
    'count', v_count,
    'definition', 'Count and total of money-out MTN / Airtel email transfers that could not be matched to an active merchant agent desk. Read-only.'
  );
end;
$function$;

revoke all on function public.get_unregistered_recipient_transfers_summary(integer) from public;
grant execute on function public.get_unregistered_recipient_transfers_summary(integer) to authenticated;