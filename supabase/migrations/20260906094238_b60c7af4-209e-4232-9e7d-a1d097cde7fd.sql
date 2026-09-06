create table if not exists public.rent_request_change_estimate (
  rent_request_id uuid primary key,
  estimated_last_change_at timestamptz not null,
  source text not null,
  confidence text not null,
  was_damaged boolean not null,
  built_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='rent_request_change_estimate_source_chk') then
    alter table public.rent_request_change_estimate
      add constraint rent_request_change_estimate_source_chk
      check (source in ('live_updated_at','audit_log','lifecycle_timestamp','created_at_only'));
  end if;
  if not exists (select 1 from pg_constraint where conname='rent_request_change_estimate_confidence_chk') then
    alter table public.rent_request_change_estimate
      add constraint rent_request_change_estimate_confidence_chk
      check (confidence in ('actual','high','medium','low'));
  end if;
end $$;

grant select on public.rent_request_change_estimate to authenticated;
grant all on public.rent_request_change_estimate to service_role;

alter table public.rent_request_change_estimate enable row level security;

create policy "Ops roles can read change estimates"
on public.rent_request_change_estimate
for select
to authenticated
using (
  public.has_role(auth.uid(), 'super_admin')
  or public.has_role(auth.uid(), 'manager')
  or public.has_role(auth.uid(), 'cfo')
  or public.has_role(auth.uid(), 'coo')
  or public.has_role(auth.uid(), 'ceo')
  or public.has_role(auth.uid(), 'cto')
);

comment on table public.rent_request_change_estimate is
  'Best-estimate last-modified time per rent request. A backfill on 2026-09-04 overwrote rent_requests.updated_at on 5,510 rows with a single timestamp and the originals are unrecoverable from this database. Rows where was_damaged is false carry the genuine live value. Where true, the estimate is reconstructed from audit_logs, then lifecycle timestamps, then created_at, and confidence says which. This table is an estimate and must never be presented as the actual modification history.';

insert into public.rent_request_change_estimate
  (rent_request_id, estimated_last_change_at, source, confidence, was_damaged)
with aud as (
  select record_id::uuid as rid, max(created_at) as last_audit
  from public.audit_logs
  where table_name = 'rent_requests' and record_id is not null
  group by 1
), base as (
  select rr.id, rr.created_at, rr.updated_at,
    (rr.updated_at = timestamptz '2026-09-04 12:37:48.268957+00') as damaged,
    greatest(
      coalesce(rr.approved_at, rr.created_at), coalesce(rr.funded_at, rr.created_at),
      coalesce(rr.disbursed_at, rr.created_at), coalesce(rr.agent_verified_at, rr.created_at),
      coalesce(rr.manager_verified_at, rr.created_at), coalesce(rr.rejected_at, rr.created_at),
      coalesce(rr.reopened_at, rr.created_at), coalesce(rr.resubmitted_at, rr.created_at),
      coalesce(rr.returned_at, rr.created_at), coalesce(rr.tenancy_ended_at, rr.created_at),
      coalesce(rr.collection_locked_at, rr.created_at), coalesce(rr.agent_payment_status_set_at, rr.created_at),
      coalesce(rr.cfo_reviewed_at, rr.created_at), coalesce(rr.coo_reviewed_at, rr.created_at),
      coalesce(rr.service_center_reviewed_at, rr.created_at), rr.created_at
    ) as lifecycle_ts
  from public.rent_requests rr
)
select
  b.id,
  case
    when not b.damaged then b.updated_at
    when a.last_audit is not null and a.last_audit >= b.lifecycle_ts then a.last_audit
    when b.lifecycle_ts > b.created_at then b.lifecycle_ts
    else b.created_at
  end,
  case
    when not b.damaged then 'live_updated_at'
    when a.last_audit is not null and a.last_audit >= b.lifecycle_ts then 'audit_log'
    when b.lifecycle_ts > b.created_at then 'lifecycle_timestamp'
    else 'created_at_only'
  end,
  case
    when not b.damaged then 'actual'
    when a.last_audit is not null and a.last_audit >= b.lifecycle_ts then 'high'
    when b.lifecycle_ts > b.created_at then 'medium'
    else 'low'
  end,
  b.damaged
from base b
left join aud a on a.rid = b.id
on conflict (rent_request_id) do nothing;

comment on column public.rent_requests.updated_at is
  'WARNING: a backfill on 2026-09-04 overwrote this column on 5,510 rows with 2026-09-04 12:37:48.268957+00. Those values are not the true modification times and the originals are unrecoverable from this database. Use public.rent_request_change_estimate for a labelled best estimate. Never run a bulk UPDATE on this table without first disabling the updated_at trigger.';