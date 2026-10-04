begin;

create table public.tppo_period_snapshots (
  id uuid primary key default gen_random_uuid(),
  granularity text not null check (granularity in ('day','week','month')),
  period_start date not null,
  period_end date not null,
  scheduled_due_ugx numeric(14,2) not null default 0,
  collected_ugx numeric(14,2) not null default 0,
  plan_count integer not null default 0,
  provisional boolean not null default true,
  frozen_at timestamptz,
  computed_at timestamptz not null default now(),
  basis jsonb not null default '{}'::jsonb,
  constraint tppo_period_snapshots_uq unique (granularity, period_start),
  constraint tppo_period_snapshots_order_ck check (period_end >= period_start),
  constraint tppo_period_snapshots_frozen_ck check (provisional or frozen_at is not null)
);

create table public.tppo_reports (
  id uuid primary key default gen_random_uuid(),
  granularity text not null check (granularity in ('day','week','month')),
  period_start date not null,
  period_end date not null,
  snapshot_id uuid not null references public.tppo_period_snapshots(id),
  prior_snapshot_id uuid references public.tppo_period_snapshots(id),
  threshold_pct numeric(5,1) not null default 70.0,
  status text not null default 'draft' check (status in ('draft','submitted')),
  created_by uuid not null default auth.uid(),
  submitted_at timestamptz,
  submitted_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tppo_reports_uq unique (granularity, period_start),
  constraint tppo_reports_order_ck check (period_end >= period_start),
  constraint tppo_reports_submitted_ck check (status = 'draft' or (submitted_at is not null and submitted_by is not null))
);

create table public.tppo_report_notes (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.tppo_reports(id) on delete cascade,
  zone text not null check (zone in ('collections','requests')),
  reason_note text not null check (char_length(btrim(reason_note)) >= 80),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint tppo_report_notes_uq unique (report_id, zone)
);

create table public.tppo_report_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.tppo_reports(id) on delete cascade,
  zone text not null check (zone in ('collections','requests')),
  item_text text not null check (char_length(btrim(item_text)) >= 10),
  owner_staff_id uuid references public.hr_staff(id),
  owner_label text,
  due_date date not null,
  outcome text check (outcome in ('done','partly_done','not_done')),
  outcome_note text,
  carried_from_action_id uuid references public.tppo_report_actions(id),
  closed_at timestamptz,
  closed_by uuid,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint tppo_report_actions_owner_ck check (owner_staff_id is not null or char_length(btrim(coalesce(owner_label,''))) > 0),
  constraint tppo_report_actions_outcome_ck check (outcome is null or char_length(btrim(coalesce(outcome_note,''))) > 0)
);

create index tppo_period_snapshots_lookup on public.tppo_period_snapshots (granularity, period_start desc);
create index tppo_reports_lookup on public.tppo_reports (granularity, period_start desc);
create index tppo_report_actions_report on public.tppo_report_actions (report_id, zone);
create index tppo_report_actions_carried on public.tppo_report_actions (carried_from_action_id) where carried_from_action_id is not null;

commit;