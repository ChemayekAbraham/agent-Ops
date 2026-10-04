create or replace function public.get_merchant_agent_movements_page(
  p_desk_id uuid default null,
  p_limit integer default 40,
  p_cursor_at timestamptz default null,
  p_cursor_id text default null,
  p_cursor_desk_id uuid default null
)
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_rows json;
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 200);
begin
  if not (
    public.has_role(auth.uid(), 'cfo') or public.has_role(auth.uid(), 'coo')
    or public.has_role(auth.uid(), 'manager') or public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'operations') or public.has_role(auth.uid(), 'financial_ops')
  ) then
    raise exception 'not_authorized';
  end if;

  with desks as (
    select ca.id as desk_id, ca.agent_id,
           coalesce(p.full_name, 'Merchant agent') as name,
           regexp_replace(coalesce(ca.float_phone, ''), '\D', '', 'g') as fp,
           regexp_replace(coalesce(ca.personal_phone, ''), '\D', '', 'g') as pp
    from public.cashout_agents ca
    left join public.profiles p on p.id = ca.agent_id
    where ca.is_active = true
      and (p_desk_id is null or ca.id = p_desk_id)
  ), phones as (
    select desk_id, name, right(x, 9) as p9
    from desks, unnest(array[fp, pp]) as x
    where length(x) >= 9
  ), emails as (
    select gt.id, gt.amount, gt.direction, gt.channel, gt.subject, gt.snippet,
           gt.transaction_id, gt.counterparty,
           coalesce(gt.internal_date, gt.created_at) as at,
           coalesce(
             nullif(right(regexp_replace(coalesce(gt.counterparty, ''), '\D', '', 'g'), 9), ''),
             nullif(right(regexp_replace(coalesce(substring(gt.snippet from 'Mobile Number: *([0-9]{9,13})'), ''), '\D', '', 'g'), 9), ''),
             nullif(right(regexp_replace(coalesce(substring(gt.snippet from 'to [^,]+, *([0-9]{9,13})'), ''), '\D', '', 'g'), 9), '')
           ) as p9
    from public.gmail_transactions gt
    where gt.channel in ('mtn_momo', 'airtel_money')
      and gt.amount is not null
      and gt.direction in ('in', 'out')
  ), matched as (
    select distinct on (e.id, ph.desk_id)
           e.id::text as id,
           ph.desk_id,
           ph.name as agent_name,
           e.direction,
           e.amount,
           e.channel,
           e.at,
           e.transaction_id,
           e.counterparty,
           e.subject,
           e.snippet
    from emails e
    join phones ph on ph.p9 = e.p9
    order by e.id, ph.desk_id, e.at desc
  )
  select coalesce(json_agg(x order by x.at desc nulls last, x.id desc, x.desk_id desc), '[]'::json)
  into v_rows
  from (
    select m.*
    from matched m
    where p_cursor_at is null
       or (m.at, m.id, m.desk_id) < (p_cursor_at, coalesce(p_cursor_id, ''), coalesce(p_cursor_desk_id, '00000000-0000-0000-0000-000000000000'::uuid))
    order by m.at desc nulls last, m.id desc, m.desk_id desc
    limit v_limit
  ) x;

  return json_build_object(
    'movements', v_rows,
    'page_size', v_limit,
    'definition', 'One keyset page of MTN / Airtel email movements matched to an active merchant agent desk phone, newest first. Read-only.'
  );
end;
$function$;

revoke all on function public.get_merchant_agent_movements_page(uuid, integer, timestamptz, text, uuid) from public;
grant execute on function public.get_merchant_agent_movements_page(uuid, integer, timestamptz, text, uuid) to authenticated;

create or replace function public.get_unregistered_recipient_transfers_page(
  p_days integer default 120,
  p_limit integer default 40,
  p_cursor_at timestamptz default null,
  p_cursor_id text default null
)
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_rows json;
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 200);
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
           bool_or(ca.is_active) as any_active,
           (array_agg(ca.id order by ca.is_active desc))[1] as desk_id
    from public.cashout_agents ca,
         unnest(array[coalesce(ca.float_phone,''), coalesce(ca.personal_phone,'')]) as x
    where length(regexp_replace(x, '\D', '', 'g')) >= 9
    group by 1
  ), emails as (
    select gt.id, gt.amount, gt.channel, gt.subject, gt.snippet,
           gt.transaction_id, gt.counterparty,
           coalesce(gt.internal_date, gt.created_at) as at,
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
  ), joined as (
    select e.*, d.p9 as desk_p9, d.any_active, d.desk_id
    from emails e
    left join desk_phones d on d.p9 = e.p9
  ), flagged as (
    select j.*
    from joined j
    where j.p9 is null
       or j.desk_p9 is null
       or j.any_active is not true
  ), paged as (
    select f.*
    from flagged f
    where p_cursor_at is null
       or (f.at, f.id::text) < (p_cursor_at, coalesce(p_cursor_id, ''))
    order by f.at desc nulls last, f.id::text desc
    limit v_limit
  )
  select coalesce(json_agg(x order by x.at desc nulls last, x.id desc), '[]'::json)
  into v_rows
  from (
    select f.id::text as id, f.amount, f.channel, f.at, f.transaction_id,
           f.counterparty, f.subject, f.snippet, f.p9 as recipient_phone,
           (select p.full_name from public.profiles p
             where f.p9 is not null
               and right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9) = f.p9
             limit 1) as profile_name,
           (select p.email from public.profiles p
             where f.p9 is not null
               and right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9) = f.p9
             limit 1) as profile_email,
           (select p.id::text from public.profiles p
             where f.p9 is not null
               and right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9) = f.p9
             limit 1) as profile_id,
           case
             when f.p9 is null then 'no_recipient_number'
             when f.desk_p9 is null then 'no_desk_match'
             else 'inactive_desk_match'
           end as reason_code,
           f.desk_id::text as matched_desk_id,
           case
             when f.p9 is null then 'no_number_found'
             when f.desk_p9 is null then 'not_a_merchant_agent'
             else 'inactive_merchant_desk'
           end as merchant_match_status,
           case
             when f.p9 is null then 'No recipient number could be read from this email, so it cannot be matched to a merchant agent desk.'
             when f.desk_p9 is null then 'The recipient number does not belong to any merchant agent desk, active or inactive.'
             else 'The recipient number belongs to a merchant agent desk that is no longer active.'
           end as reason
    from paged f
  ) x;

  return json_build_object(
    'transfers', v_rows,
    'page_size', v_limit,
    'definition', 'One keyset page of money-out MTN / Airtel email transfers that could not be matched to an active merchant agent desk, newest first. Read-only flag.'
  );
end;
$function$;

revoke all on function public.get_unregistered_recipient_transfers_page(integer, integer, timestamptz, text) from public;
grant execute on function public.get_unregistered_recipient_transfers_page(integer, integer, timestamptz, text) to authenticated;

create index if not exists gmail_transactions_channel_at_idx
  on public.gmail_transactions (channel, (coalesce(internal_date, created_at)) desc, id desc);