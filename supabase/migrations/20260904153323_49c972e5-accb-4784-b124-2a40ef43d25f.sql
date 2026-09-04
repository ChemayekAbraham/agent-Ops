alter table public.tppo_period_snapshots
  add column if not exists arrears_target_ugx numeric,
  add column if not exists arrears_target_plan_count integer,
  add column if not exists arrears_outstanding_ugx numeric;

comment on column public.tppo_period_snapshots.arrears_target_ugx is
  'Collection target for plans in arrears that have no scheduled instalment on a given day of this period, at their daily instalment rate. Disjoint from scheduled_due_ugx: a plan inside its term contributes to scheduled_due_ugx, a plan past its term contributes here. Never add this to scheduled_due_ugx and call the result an obligation.';

comment on column public.tppo_period_snapshots.arrears_target_plan_count is
  'Number of plans contributing to arrears_target_ugx.';

comment on column public.tppo_period_snapshots.arrears_outstanding_ugx is
  'Cumulative unpaid balance across all plans in arrears as at the earlier of period_end and today. A stock figure, not a target for the period.';