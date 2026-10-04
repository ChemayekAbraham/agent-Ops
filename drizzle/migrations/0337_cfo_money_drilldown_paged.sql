-- Read-only reporting layer: paged drill-downs + separate totals. No data or money logic touched.
create or replace function public._cfo_paid_out_base(p_from timestamptz, p_to timestamptz, p_status text, p_method text, p_type text, p_recipient text)
returns table(id uuid, ts timestamptz, status text, amount numeric, ptype text, pn text, pp text)
language sql stable security definer set search_path = public as $$
  select w.id, b.ts, w.status::text, w.amount, b.ptype, p.full_name::text, p.phone::text
  from withdrawal_requests w
  cross join lateral (select
      case when w.status='pending' then w.created_at else w.processed_at end ts,
      case when w.payout_route_ref like 'portfolio:%' or w.reason ilike '%portfolio%' then 'Supporter returns'
           when w.reason ilike '%commission%' then 'Commission'
           when w.reason ilike '%landlord%' then 'Landlord'
           when w.reason ilike '%salary%' or w.reason ilike '%payroll%' then 'Salary'
           else 'Wallet withdrawal' end ptype) b
  left join profiles p on p_recipient is not null and p.id = w.user_id
  where w.status in ('completed','paid','pending')
    and (p_status is null or (p_status='confirmed' and w.status in ('completed','paid')) or w.status = p_status)
    and (p_method is null or w.payout_method = p_method)
    and b.ts >= p_from and b.ts < p_to
    and (p_type is null or b.ptype = p_type)
    and (p_recipient is null or p.full_name ilike '%'||p_recipient||'%' or p.phone ilike '%'||p_recipient||'%')
$$;
revoke all on function public._cfo_paid_out_base(timestamptz,timestamptz,text,text,text,text) from public, anon, authenticated;

create or replace function public._cfo_received_base(p_from timestamptz, p_to timestamptz, p_status text, p_method text, p_type text, p_payer text)
returns table(id uuid, ts timestamptz, status text, amount numeric)
language sql stable security definer set search_path = public as $$
  select d.id, b.ts, d.status::text, d.amount
  from deposit_requests d
  cross join lateral (select
      case when d.status='pending' then d.created_at else coalesce(d.approved_at,d.created_at) end ts,
      case d.deposit_purpose::text when 'operational_float' then 'Operational float' when 'personal_deposit' then 'Personal deposit' when 'partnership_deposit' then 'Partnership deposit' when 'personal_rent_repayment' then 'Rent repayment' else 'Other' end rtype,
      case when lower(d.provider) in ('mtn','airtel') then 'mobile_money' when lower(d.provider) in ('bank','bank_transfer') then 'bank_transfer' when d.provider in ('cash_deposit','agent_cash') then 'cash' else lower(coalesce(d.provider,'other')) end meth) b
  left join profiles p on p_payer is not null and p.id = d.user_id
  where d.status in ('approved','pending')
    and (p_status is null or (p_status='confirmed' and d.status='approved') or d.status = p_status)
    and b.ts >= p_from and b.ts < p_to
    and (p_method is null or b.meth = p_method) and (p_type is null or b.rtype = p_type)
    and (p_payer is null or coalesce(p.full_name,'Unknown') ilike '%'||p_payer||'%' or p.phone ilike '%'||p_payer||'%')
$$;
revoke all on function public._cfo_received_base(timestamptz,timestamptz,text,text,text,text) from public, anon, authenticated;

create or replace function public.get_cfo_money_drilldown_totals(p_kind text, p_from timestamptz, p_to timestamptz, p_status text default null, p_method text default null, p_type text default null, p_person text default null)
returns table(match_count bigint, confirmed_count bigint, pending_count bigint, confirmed_amount numeric, pending_amount numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_role(auth.uid(),'cfo') or has_role(auth.uid(),'ceo') or has_role(auth.uid(),'super_admin')) then raise exception 'not authorized'; end if;
  if p_kind = 'paid_out' then
    return query select count(*), count(*) filter (where b.status<>'pending'), count(*) filter (where b.status='pending'),
      coalesce(sum(b.amount) filter (where b.status<>'pending'),0), coalesce(sum(b.amount) filter (where b.status='pending'),0)
      from _cfo_paid_out_base(p_from,p_to,p_status,p_method,p_type,p_person) b;
  elsif p_kind = 'received' then
    return query select count(*), count(*) filter (where b.status<>'pending'), count(*) filter (where b.status='pending'),
      coalesce(sum(b.amount) filter (where b.status<>'pending'),0), coalesce(sum(b.amount) filter (where b.status='pending'),0)
      from _cfo_received_base(p_from,p_to,p_status,p_method,p_type,p_person) b;
  else raise exception 'unknown kind'; end if;
end $$;

create or replace function public.get_cfo_money_paid_out_page(p_from timestamptz, p_to timestamptz, p_status text default null, p_method text default null, p_type text default null, p_recipient text default null, p_offset int default 0, p_limit int default 50)
returns table(paid_at timestamptz, created_at timestamptz, id uuid, payout_reference text, recipient text, recipient_phone text, payout_type text, amount numeric, payment_method text, status text, source_account text, description text, ledger_reference text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_role(auth.uid(),'cfo') or has_role(auth.uid(),'ceo') or has_role(auth.uid(),'super_admin')) then raise exception 'not authorized'; end if;
  return query
  with pg as (select b.id, b.ts, b.ptype from _cfo_paid_out_base(p_from,p_to,p_status,p_method,p_type,p_recipient) b
              order by b.ts desc, b.id offset greatest(coalesce(p_offset,0),0) limit least(greatest(coalesce(p_limit,50),1),1000))
  select w.processed_at, w.created_at, w.id, w.fin_ops_reference::text, coalesce(p.full_name,'Unknown')::text, p.phone::text, pg.ptype, w.amount,
         w.payout_method::text, w.status::text,
         coalesce(w.fin_ops_payment_method::text, w.payout_method::text) || coalesce(' · '||w.payout_route_ref::text,''),
         w.reason::text,
         (select string_agg(distinct g.transaction_group_id::text, ', ') from general_ledger g where g.source_table='withdrawal_requests' and g.source_id=w.id)
  from pg join withdrawal_requests w on w.id = pg.id left join profiles p on p.id = w.user_id
  order by pg.ts desc, pg.id;
end $$;

create or replace function public.get_cfo_money_received_page(p_from timestamptz, p_to timestamptz, p_status text default null, p_method text default null, p_type text default null, p_payer text default null, p_offset int default 0, p_limit int default 50)
returns table(id uuid, received_at timestamptz, receipt_reference text, payer text, payer_phone text, receipt_type text, amount numeric, payment_method text, destination text, status text, description text, ledger_reference text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_role(auth.uid(),'cfo') or has_role(auth.uid(),'ceo') or has_role(auth.uid(),'super_admin')) then raise exception 'not authorized'; end if;
  return query
  with pg as (select b.id, b.ts from _cfo_received_base(p_from,p_to,p_status,p_method,p_type,p_payer) b
              order by b.ts desc, b.id offset greatest(coalesce(p_offset,0),0) limit least(greatest(coalesce(p_limit,50),1),1000))
  select d.id, pg.ts, d.transaction_id::text, coalesce(p.full_name,'Unknown')::text, p.phone::text,
    case d.deposit_purpose::text when 'operational_float' then 'Operational float' when 'personal_deposit' then 'Personal deposit' when 'partnership_deposit' then 'Partnership deposit' when 'personal_rent_repayment' then 'Rent repayment' else 'Other' end,
    d.amount,
    case when lower(d.provider) in ('mtn','airtel') then 'mobile_money' when lower(d.provider) in ('bank','bank_transfer') then 'bank_transfer' when d.provider in ('cash_deposit','agent_cash') then 'cash' else lower(coalesce(d.provider,'other')) end,
    (case when d.deposit_purpose::text='operational_float' then 'Float wallet' else 'Withdrawable wallet' end || ' · ' || upper(coalesce(d.provider,'')))::text,
    d.status::text, coalesce(d.rejection_reason,d.notes)::text,
    (select string_agg(distinct g.transaction_group_id::text, ', ') from general_ledger g where g.source_table='deposit_requests' and g.source_id=d.id)
  from pg join deposit_requests d on d.id = pg.id left join profiles p on p.id = d.user_id
  order by pg.ts desc, pg.id;
end $$;

revoke all on function public.get_cfo_money_drilldown_totals(text,timestamptz,timestamptz,text,text,text,text) from public, anon;
revoke all on function public.get_cfo_money_paid_out_page(timestamptz,timestamptz,text,text,text,text,int,int) from public, anon;
revoke all on function public.get_cfo_money_received_page(timestamptz,timestamptz,text,text,text,text,int,int) from public, anon;
grant execute on function public.get_cfo_money_drilldown_totals(text,timestamptz,timestamptz,text,text,text,text) to authenticated, service_role;
grant execute on function public.get_cfo_money_paid_out_page(timestamptz,timestamptz,text,text,text,text,int,int) to authenticated, service_role;
grant execute on function public.get_cfo_money_received_page(timestamptz,timestamptz,text,text,text,text,int,int) to authenticated, service_role;