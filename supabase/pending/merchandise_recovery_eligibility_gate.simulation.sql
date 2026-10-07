with elig as (
 select rp.id, rp.sale_id, rp.outstanding_balance, coalesce(rp.is_bike_lease,false) bike, s.order_status,
  case when rp.sale_id is null then true
       when s.id is null then false
       else s.order_status in ('approved','processing','issued','completed')
        and case s.fulfilment_type when 'company_issued' then s.handed_over_at is not null when 'outsourced' then s.cfo_disbursed_at is not null else true end end ok
 from merchandise_recovery_plans rp left join merchandise_sales s on s.id=rp.sale_id
 where rp.status='active' and rp.outstanding_balance>0)
select bike, order_status, ok, count(*), round(sum(outstanding_balance)) from elig group by 1,2,3 order by 1,2;
select round(sum(outstanding_amount)) total_now,
 round(sum(outstanding_amount) filter (where source_table not in ('merchandise_recovery_plans','merchandise_sales'))) non_merch
 from v_receivables_lines;
