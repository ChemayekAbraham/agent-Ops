begin;

-- tppo_period_snapshots
alter table public.tppo_period_snapshots enable row level security;

drop policy if exists "tenant_ops_select_period_snapshots" on public.tppo_period_snapshots;
create policy "tenant_ops_select_period_snapshots" on public.tppo_period_snapshots
for select to authenticated
using (
  public.has_role(auth.uid(), 'tenant_ops'::app_role)
  or public.has_role(auth.uid(), 'coo'::app_role)
  or public.has_role(auth.uid(), 'ceo'::app_role)
  or public.has_role(auth.uid(), 'super_admin'::app_role)
);

-- tppo_reports
alter table public.tppo_reports enable row level security;

drop policy if exists "tenant_ops_select_reports" on public.tppo_reports;
create policy "tenant_ops_select_reports" on public.tppo_reports
for select to authenticated
using (
  public.has_role(auth.uid(), 'tenant_ops'::app_role)
  or public.has_role(auth.uid(), 'coo'::app_role)
  or public.has_role(auth.uid(), 'ceo'::app_role)
  or public.has_role(auth.uid(), 'super_admin'::app_role)
);

drop policy if exists "tenant_ops_insert_reports" on public.tppo_reports;
create policy "tenant_ops_insert_reports" on public.tppo_reports
for insert to authenticated
with check (public.has_role(auth.uid(), 'tenant_ops'::app_role));

drop policy if exists "tenant_ops_update_reports" on public.tppo_reports;
create policy "tenant_ops_update_reports" on public.tppo_reports
for update to authenticated
using (
  public.has_role(auth.uid(), 'tenant_ops'::app_role)
  and status = 'draft'
)
with check (public.has_role(auth.uid(), 'tenant_ops'::app_role));

-- tppo_report_notes
alter table public.tppo_report_notes enable row level security;

drop policy if exists "tenant_ops_select_report_notes" on public.tppo_report_notes;
create policy "tenant_ops_select_report_notes" on public.tppo_report_notes
for select to authenticated
using (
  public.has_role(auth.uid(), 'tenant_ops'::app_role)
  or public.has_role(auth.uid(), 'coo'::app_role)
  or public.has_role(auth.uid(), 'ceo'::app_role)
  or public.has_role(auth.uid(), 'super_admin'::app_role)
);

drop policy if exists "tenant_ops_insert_report_notes" on public.tppo_report_notes;
create policy "tenant_ops_insert_report_notes" on public.tppo_report_notes
for insert to authenticated
with check (public.has_role(auth.uid(), 'tenant_ops'::app_role));

drop policy if exists "tenant_ops_update_report_notes" on public.tppo_report_notes;
create policy "tenant_ops_update_report_notes" on public.tppo_report_notes
for update to authenticated
using (
  public.has_role(auth.uid(), 'tenant_ops'::app_role)
  and exists (select 1 from public.tppo_reports r where r.id = report_id and r.status = 'draft')
)
with check (public.has_role(auth.uid(), 'tenant_ops'::app_role));

-- tppo_report_actions
alter table public.tppo_report_actions enable row level security;

drop policy if exists "tenant_ops_select_report_actions" on public.tppo_report_actions;
create policy "tenant_ops_select_report_actions" on public.tppo_report_actions
for select to authenticated
using (
  public.has_role(auth.uid(), 'tenant_ops'::app_role)
  or public.has_role(auth.uid(), 'coo'::app_role)
  or public.has_role(auth.uid(), 'ceo'::app_role)
  or public.has_role(auth.uid(), 'super_admin'::app_role)
);

drop policy if exists "tenant_ops_insert_report_actions" on public.tppo_report_actions;
create policy "tenant_ops_insert_report_actions" on public.tppo_report_actions
for insert to authenticated
with check (public.has_role(auth.uid(), 'tenant_ops'::app_role));

drop policy if exists "tenant_ops_update_report_actions" on public.tppo_report_actions;
create policy "tenant_ops_update_report_actions" on public.tppo_report_actions
for update to authenticated
using (
  public.has_role(auth.uid(), 'tenant_ops'::app_role)
  and exists (select 1 from public.tppo_reports r where r.id = report_id and r.status = 'draft')
)
with check (public.has_role(auth.uid(), 'tenant_ops'::app_role));

commit;