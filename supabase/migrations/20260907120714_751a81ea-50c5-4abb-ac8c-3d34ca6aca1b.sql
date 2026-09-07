create or replace view public.v_rent_repaid_reconciliation
with (security_invoker = on) as
with ledger as (
  select x.rent_request_id,
         sum(x.amount) as ledger_total,
         count(*) as ledger_rows,
         max(x.created_at) as last_payment_at
  from (
    select ac.rent_request_id, ac.amount, ac.created_at
    from public.agent_collections ac
    where ac.rent_request_id is not null
    union all
    select rp.rent_request_id, rp.amount, rp.created_at
    from public.repayments rp
    where rp.rent_request_id is not null
      and not exists (
        select 1 from public.agent_collections a
        where a.rent_request_id = rp.rent_request_id
          and a.amount = rp.amount
          and abs(extract(epoch from (a.created_at - rp.created_at))) < 300
      )
  ) x
  group by x.rent_request_id
), logged_edits as (
  select rent_request_id,
         count(*) as logged_edit_count,
         sum(coalesce(new_amount_repaid, 0) - coalesce(old_amount_repaid, 0)) as logged_edit_net
  from public.rent_amount_change_log
  where rent_request_id is not null
  group by rent_request_id
), audited as (
  select a.record_id::uuid as rent_request_id, count(*) as audit_rows
  from public.audit_logs a
  where a.table_name = 'rent_requests'
    and a.record_id is not null
    and (a.old_values->>'amount_repaid') is distinct from (a.new_values->>'amount_repaid')
  group by a.record_id::uuid
)
select
  rr.id                                            as rent_request_id,
  rr.tenant_id,
  rr.agent_id,
  rr.status,
  coalesce(rr.total_repayment, 0)::numeric         as total_repayment,
  coalesce(rr.amount_repaid, 0)::numeric           as amount_repaid,
  coalesce(l.ledger_total, 0)::numeric             as ledger_total,
  coalesce(l.ledger_rows, 0)::integer              as ledger_rows,
  l.last_payment_at,
  coalesce(e.logged_edit_count, 0)::integer        as logged_edit_count,
  coalesce(e.logged_edit_net, 0)::numeric          as logged_edit_net,
  coalesce(au.audit_rows, 0)::integer              as audit_rows,
  (coalesce(rr.amount_repaid, 0) - coalesce(l.ledger_total, 0))::numeric as unbacked_by_ledger,
  (coalesce(rr.amount_repaid, 0) - coalesce(l.ledger_total, 0) - coalesce(e.logged_edit_net, 0))::numeric as unexplained,
  case
    when abs(coalesce(rr.amount_repaid,0) - coalesce(l.ledger_total,0)) <= 1 then 'reconciled'
    when abs(coalesce(rr.amount_repaid,0) - coalesce(l.ledger_total,0) - coalesce(e.logged_edit_net,0)) <= 1 then 'explained_by_logged_edit'
    when coalesce(rr.amount_repaid,0) > coalesce(l.ledger_total,0) then 'unexplained_credit'
    else 'unexplained_shortfall'
  end as reconciliation_state
from public.rent_requests rr
left join ledger l on l.rent_request_id = rr.id
left join logged_edits e on e.rent_request_id = rr.id
left join audited au on au.rent_request_id = rr.id;

comment on view public.v_rent_repaid_reconciliation is
  'Standing reconciliation of rent_requests.amount_repaid against the de-duplicated payment ledger (agent_collections plus repayments rows with no matching collection within five minutes), the logged balance edits in rent_amount_change_log, and whether audit_logs recorded the change at all. reconciliation_state of unexplained_credit means a balance was credited with no payment record and no logged edit — treat those as exceptions requiring evidence, not as data to be silently corrected. amount_repaid is writable by fourteen SECURITY DEFINER functions, none of which write to rent_amount_change_log, which is why this view exists.';

revoke all on public.v_rent_repaid_reconciliation from anon;