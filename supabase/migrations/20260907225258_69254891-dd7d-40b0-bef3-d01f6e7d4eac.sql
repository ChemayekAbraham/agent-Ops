create table if not exists public.rent_repaid_reconciliation_snapshot (
  id bigserial primary key,
  snapshot_at timestamptz not null default now(),
  snapshot_reason text not null,
  rent_request_id uuid not null,
  tenant_name text,
  agent_id uuid,
  agent_name text,
  status text,
  total_repayment numeric,
  amount_repaid numeric,
  ledger_total numeric,
  ledger_rows integer,
  last_payment_at timestamptz,
  logged_edit_count integer,
  logged_edit_net numeric,
  audit_rows integer,
  unbacked_by_ledger numeric,
  unexplained numeric,
  reconciliation_state text
);

create index if not exists rent_repaid_recon_snap_plan_idx
  on public.rent_repaid_reconciliation_snapshot (rent_request_id, snapshot_at desc);
create index if not exists rent_repaid_recon_snap_agent_idx
  on public.rent_repaid_reconciliation_snapshot (agent_id, snapshot_at desc);

comment on table public.rent_repaid_reconciliation_snapshot is
  'Immutable point-in-time copies of the repayment reconciliation exception set. Append only: never update or delete a row here, and never re-point an existing snapshot_reason at new figures. Taken so balances flagged as unbacked by the payment ledger can be reviewed against a fixed baseline after the live figures move.';

grant select on public.rent_repaid_reconciliation_snapshot to authenticated;
grant all on public.rent_repaid_reconciliation_snapshot to service_role;

alter table public.rent_repaid_reconciliation_snapshot enable row level security;

create policy "Finance and executive can read reconciliation snapshots"
on public.rent_repaid_reconciliation_snapshot for select to authenticated
using (
  has_role(auth.uid(), 'super_admin') or has_role(auth.uid(), 'ceo')
  or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'coo')
);

insert into public.rent_repaid_reconciliation_snapshot (
  snapshot_reason, rent_request_id, tenant_name, agent_id, agent_name, status,
  total_repayment, amount_repaid, ledger_total, ledger_rows, last_payment_at,
  logged_edit_count, logged_edit_net, audit_rows,
  unbacked_by_ledger, unexplained, reconciliation_state
)
select
  'baseline before remediation 2026-09-07',
  r.rent_request_id, tp.full_name, r.agent_id, ap.full_name, r.status,
  r.total_repayment, r.amount_repaid, r.ledger_total, r.ledger_rows, r.last_payment_at,
  r.logged_edit_count, r.logged_edit_net, r.audit_rows,
  r.unbacked_by_ledger, r.unexplained, r.reconciliation_state
from public.v_rent_repaid_reconciliation r
left join public.profiles tp on tp.id = r.tenant_id
left join public.profiles ap on ap.id = r.agent_id;