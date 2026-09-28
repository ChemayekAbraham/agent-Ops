CREATE OR REPLACE FUNCTION public.get_cfo_money_paid_out_drilldown(p_from timestamptz, p_to timestamptz, p_status text DEFAULT NULL, p_method text DEFAULT NULL, p_type text DEFAULT NULL, p_recipient text DEFAULT NULL, p_limit int DEFAULT 10000)
RETURNS TABLE(paid_at timestamptz, created_at timestamptz, id uuid, payout_reference text, recipient text, recipient_phone text, payout_type text, amount numeric, payment_method text, status text, source_account text, description text, ledger_reference text, match_count bigint, match_confirmed_amount numeric, match_pending_amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
begin
  if not (has_role(auth.uid(),'cfo') or has_role(auth.uid(),'ceo') or has_role(auth.uid(),'super_admin')) then raise exception 'not authorized'; end if;
  return query
  with x as (
    select w.*, p.full_name pn, p.phone pp,
      case when w.payout_route_ref like 'portfolio:%' or w.reason ilike '%portfolio%' then 'Supporter returns'
           when w.reason ilike '%commission%' then 'Commission'
           when w.reason ilike '%landlord%' then 'Landlord'
           when w.reason ilike '%salary%' or w.reason ilike '%payroll%' then 'Salary'
           else 'Wallet withdrawal' end ptype,
      case when w.status='pending' then w.created_at else w.processed_at end ts
    from withdrawal_requests w left join profiles p on p.id = w.user_id
    where w.status in ('completed','paid','pending')),
  f as (
    select * from x where x.ts >= p_from and x.ts < p_to
      and (p_status is null or (p_status='confirmed' and x.status in ('completed','paid')) or x.status = p_status)
      and (p_method is null or x.payout_method = p_method)
      and (p_type is null or x.ptype = p_type)
      and (p_recipient is null or x.pn ilike '%'||p_recipient||'%' or x.pp ilike '%'||p_recipient||'%')),
  t as (select count(*) c, coalesce(sum(amount) filter (where f.status in ('completed','paid')),0) ca, coalesce(sum(amount) filter (where f.status='pending'),0) pa from f)
  select f.processed_at, f.created_at, f.id, f.fin_ops_reference::text, coalesce(f.pn,'Unknown')::text, f.pp::text, f.ptype, f.amount,
         f.payout_method::text, f.status::text,
         coalesce(f.fin_ops_payment_method::text, f.payout_method::text) || coalesce(' · '||f.payout_route_ref::text,''),
         f.reason::text,
         (select string_agg(distinct g.transaction_group_id::text, ', ') from general_ledger g where g.source_table='withdrawal_requests' and g.source_id=f.id),
         t.c, t.ca, t.pa
  from f cross join t
  order by f.ts desc
  limit least(coalesce(p_limit,10000),10000);
end $$;

CREATE OR REPLACE FUNCTION public.get_cfo_money_received_drilldown(p_from timestamptz, p_to timestamptz, p_status text DEFAULT NULL, p_method text DEFAULT NULL, p_type text DEFAULT NULL, p_payer text DEFAULT NULL, p_limit int DEFAULT 10000)
RETURNS TABLE(id uuid, received_at timestamptz, receipt_reference text, payer text, payer_phone text, receipt_type text, amount numeric, payment_method text, destination text, status text, description text, ledger_reference text, match_count bigint, match_confirmed_amount numeric, match_pending_amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
begin
  if not (has_role(auth.uid(),'cfo') or has_role(auth.uid(),'ceo') or has_role(auth.uid(),'super_admin')) then raise exception 'not authorized'; end if;
  return query
  with x as (
    select d.id did, case when d.status='pending' then d.created_at else coalesce(d.approved_at,d.created_at) end ts,
      d.transaction_id::text rref, coalesce(p.full_name,'Unknown')::text pn, p.phone::text pp,
      case d.deposit_purpose::text when 'operational_float' then 'Operational float' when 'personal_deposit' then 'Personal deposit' when 'partnership_deposit' then 'Partnership deposit' when 'personal_rent_repayment' then 'Rent repayment' else 'Other' end rtype,
      d.amount amt,
      case when lower(d.provider) in ('mtn','airtel') then 'mobile_money' when lower(d.provider) in ('bank','bank_transfer') then 'bank_transfer' when d.provider in ('cash_deposit','agent_cash') then 'cash' else lower(coalesce(d.provider,'other')) end meth,
      (case when d.deposit_purpose::text='operational_float' then 'Float wallet' else 'Withdrawable wallet' end || ' · ' || upper(coalesce(d.provider,'')))::text dest,
      d.status::text st, coalesce(d.rejection_reason,d.notes)::text descr
    from deposit_requests d left join profiles p on p.id=d.user_id
    where d.status in ('approved','pending')),
  f as (
    select * from x where x.ts >= p_from and x.ts < p_to
      and (p_status is null or (p_status='confirmed' and x.st='approved') or x.st=p_status)
      and (p_payer is null or x.pn ilike '%'||p_payer||'%' or x.pp ilike '%'||p_payer||'%')
      and (p_method is null or x.meth=p_method) and (p_type is null or x.rtype=p_type)),
  t as (select count(*) c, coalesce(sum(amt) filter (where f.st='approved'),0) ca, coalesce(sum(amt) filter (where f.st='pending'),0) pa from f)
  select f.did, f.ts, f.rref, f.pn, f.pp, f.rtype, f.amt, f.meth, f.dest, f.st, f.descr,
    (select string_agg(distinct g.transaction_group_id::text, ', ') from general_ledger g where g.source_table='deposit_requests' and g.source_id=f.did),
    t.c, t.ca, t.pa
  from f cross join t
  order by f.ts desc
  limit least(coalesce(p_limit,10000),10000);
end $$;

REVOKE ALL ON FUNCTION public.get_cfo_money_paid_out_drilldown(timestamptz,timestamptz,text,text,text,text,int) FROM public, anon;
REVOKE ALL ON FUNCTION public.get_cfo_money_received_drilldown(timestamptz,timestamptz,text,text,text,text,int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_money_paid_out_drilldown(timestamptz,timestamptz,text,text,text,text,int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cfo_money_received_drilldown(timestamptz,timestamptz,text,text,text,text,int) TO authenticated;