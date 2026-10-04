create table if not exists public.tppo_period_snapshots_archive (
  archived_at timestamptz not null default now(),
  archive_reason text not null,
  snapshot_id uuid,
  granularity text,
  period_start date,
  period_end date,
  scheduled_due_ugx numeric,
  collected_ugx numeric,
  collected_total_ugx numeric,
  arrears_recovered_ugx numeric,
  unallocated_ugx numeric,
  plan_count integer,
  arrears_plan_count integer,
  arrears_target_ugx numeric,
  arrears_target_plan_count integer,
  arrears_outstanding_ugx numeric,
  provisional boolean,
  frozen_at timestamptz,
  computed_at timestamptz,
  basis jsonb
);

comment on table public.tppo_period_snapshots_archive is
  'Immutable archive of tppo_period_snapshots rows taken before any basis refreeze. Append only. Never update or delete rows here.';

GRANT SELECT ON public.tppo_period_snapshots_archive TO authenticated;
GRANT ALL ON public.tppo_period_snapshots_archive TO service_role;

ALTER TABLE public.tppo_period_snapshots_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Executive roles can view tppo snapshot archive"
ON public.tppo_period_snapshots_archive
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'tenant_ops')
);

insert into public.tppo_period_snapshots_archive (
  archive_reason, snapshot_id, granularity, period_start, period_end,
  scheduled_due_ugx, collected_ugx, collected_total_ugx, arrears_recovered_ugx, unallocated_ugx,
  plan_count, arrears_plan_count, arrears_target_ugx, arrears_target_plan_count, arrears_outstanding_ugx,
  provisional, frozen_at, computed_at, basis)
select 'pre basis-2 refreeze 2026-09-05', id, granularity, period_start, period_end,
  scheduled_due_ugx, collected_ugx, collected_total_ugx, arrears_recovered_ugx, unallocated_ugx,
  plan_count, arrears_plan_count, arrears_target_ugx, arrears_target_plan_count, arrears_outstanding_ugx,
  provisional, frozen_at, computed_at, basis
from public.tppo_period_snapshots;