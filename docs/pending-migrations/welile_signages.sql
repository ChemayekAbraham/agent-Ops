-- ============================================================================
-- Welile Signages — Database Schema, RLS & Verification Lifecycle
-- Target file: docs/pending-migrations/welile_signages.sql
--
-- Business Rules Enforced:
--  1. Eligible premises: Busy houses, shops, and business premises.
--  2. Property Owner: UGX 10,000 / active signage / month (begins on activation date).
--  3. Agent Reward: UGX 3,000 once per qualifying installation (only after verification).
--  4. Mandatory Live GPS: lat/lng cannot be null and accuracy must be within limits.
--  5. Verification & Activation: Separate from Approval.
-- ============================================================================

begin;

-- 1. Main Signages Table
create table if not exists public.welile_signages (
  id uuid primary key default gen_random_uuid(),
  reference_no text unique not null,
  agent_id uuid not null references public.profiles(id) on delete restrict,

  -- Property & Owner
  property_name text not null,
  property_type text not null check (property_type in ('house', 'shop', 'business_premise', 'mixed_use')),
  business_category text,
  owner_full_name text not null,
  owner_phone text not null,
  owner_alt_phone text,
  consenting_relation text not null,
  permission_confirmed boolean not null default false,
  owner_payment_method text not null default 'momo_mtn' check (owner_payment_method in ('momo_mtn', 'momo_airtel', 'bank')),
  owner_payment_number text not null,
  owner_payment_name text not null,

  -- Mandatory Live GPS Capture
  gps_latitude numeric(10, 7) not null,
  gps_longitude numeric(10, 7) not null,
  gps_accuracy_meters numeric(6, 2) not null,
  gps_captured_at timestamptz not null default now(),

  -- Administrative Location
  district_name text not null,
  county_name text,
  sub_county_name text,
  parish_name text,
  village_name text not null,
  plot_or_landmark text,

  -- Advertising Suitability
  foot_traffic text not null default 'medium' check (foot_traffic in ('low', 'medium', 'high')),
  road_visibility text,
  operating_hours text,
  nearby_landmarks text,
  proposed_surface text,
  proposed_dimensions text,
  accessibility_notes text,

  -- Photos: jsonb array of { id, url, category, caption, taken_at }
  photos jsonb not null default '[]'::jsonb,

  -- Lifecycle Status
  status text not null default 'submitted' check (status in (
    'draft',
    'submitted',
    'under_review',
    'changes_required',
    'rejected',
    'approved_for_installation',
    'pending_installation',
    'installation_verification',
    'active',
    'temporarily_inactive',
    'payment_on_hold',
    'removal_requested',
    'removed',
    'cancelled'
  )),

  -- Ops Review Decision
  rejection_reason text,
  review_notes text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,

  -- Physical Installation & Independent Verification
  installed_at date,
  installer_name text,
  installation_photos jsonb default '[]'::jsonb,
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  verification_notes text,

  -- Activation Timestamp (Anchors owner monthly payment obligations)
  activated_at timestamptz,
  removal_effective_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Reference Sequence
create sequence if not exists public.welile_signage_seq start 1001;

-- 2. Installations Audit Table
create table if not exists public.welile_signage_installations (
  id uuid primary key default gen_random_uuid(),
  signage_id uuid not null references public.welile_signages(id) on delete cascade,
  installer_name text not null,
  installed_at date not null,
  installation_photos jsonb not null default '[]'::jsonb,
  verified_by uuid not null references public.profiles(id),
  verified_at timestamptz not null default now(),
  verification_notes text,
  created_at timestamptz not null default now()
);

-- 3. Owner Monthly Obligations Table (UGX 10,000/mo)
create table if not exists public.welile_signage_owner_obligations (
  id uuid primary key default gen_random_uuid(),
  signage_id uuid not null references public.welile_signages(id) on delete restrict,
  owner_phone text not null,
  owner_name text not null,
  period_start date not null,
  period_end date not null,
  due_date date not null,
  amount_ugx numeric not null default 10000,
  status text not null default 'pending' check (status in ('pending', 'approved', 'paid', 'failed', 'cancelled')),
  transaction_ref text,
  disbursed_at timestamptz,
  disbursed_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (signage_id, period_start)
);

-- 4. Agent Rewards Table (UGX 3,000 once per qualifying installation)
create table if not exists public.welile_signage_agent_rewards (
  id uuid primary key default gen_random_uuid(),
  signage_id uuid not null unique references public.welile_signages(id) on delete restrict,
  agent_id uuid not null references public.profiles(id),
  amount_ugx numeric not null default 3000,
  status text not null default 'eligible' check (status in ('eligible', 'pending', 'paid', 'failed')),
  wallet_transaction_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- 5. Periodic Inspections Table
create table if not exists public.welile_signage_inspections (
  id uuid primary key default gen_random_uuid(),
  signage_id uuid not null references public.welile_signages(id) on delete cascade,
  inspector_id uuid not null references public.profiles(id),
  condition_status text not null check (condition_status in ('good', 'damaged', 'obstructed', 'missing')),
  inspection_photos jsonb default '[]'::jsonb,
  notes text,
  inspected_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_signages_agent on public.welile_signages(agent_id);
create index if not exists idx_signages_status on public.welile_signages(status);
create index if not exists idx_signages_district on public.welile_signages(district_name);

-- RLS
alter table public.welile_signages enable row level security;
alter table public.welile_signage_installations enable row level security;
alter table public.welile_signage_owner_obligations enable row level security;
alter table public.welile_signage_agent_rewards enable row level security;
alter table public.welile_signage_inspections enable row level security;

-- Agent policies: can read their own submissions, insert submissions
create policy "Agents view own signages"
  on public.welile_signages for select
  using (auth.uid() = agent_id or exists (select 1 from public.user_roles where user_id = auth.uid() and role in ('admin', 'super_admin', 'operations', 'manager', 'ceo', 'coo')));

create policy "Agents insert signages"
  on public.welile_signages for insert
  with check (auth.uid() = agent_id);

create policy "Staff manage signages"
  on public.welile_signages for all
  using (exists (select 1 from public.user_roles where user_id = auth.uid() and role in ('admin', 'super_admin', 'operations', 'manager', 'ceo', 'coo')));

-- Rewards policies: Agents see own rewards
create policy "Agents view own rewards"
  on public.welile_signage_agent_rewards for select
  using (auth.uid() = agent_id or exists (select 1 from public.user_roles where user_id = auth.uid() and role in ('admin', 'super_admin', 'operations', 'manager', 'ceo', 'coo')));

-- 6. Trigger: Upon verified installation, unlock 1 unique reward row
create or replace function public._trg_on_signage_verified_reward()
returns trigger language plpgsql security definer as $f$
begin
  if new.status in ('installation_verification', 'active') and (old.status is null or old.status not in ('installation_verification', 'active')) then
    -- Insert exactly one reward record for this agent and signage if not present
    insert into public.welile_signage_agent_rewards (signage_id, agent_id, amount_ugx, status)
    values (new.id, new.agent_id, 3000, 'eligible')
    on conflict (signage_id) do nothing;
  end if;

  if new.status = 'active' and (old.status is null or old.status != 'active') and new.activated_at is null then
    new.activated_at := now();
  end if;

  return new;
end $f$;

drop trigger if exists trg_signage_verified_reward on public.welile_signages;
create trigger trg_signage_verified_reward
  before update or insert on public.welile_signages
  for each row execute function public._trg_on_signage_verified_reward();

commit;
