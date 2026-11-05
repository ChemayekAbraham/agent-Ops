create sequence if not exists public.welile_signage_seq start 1001;

create table public.welile_signages (
  id uuid primary key default gen_random_uuid(),
  reference_no text unique,
  agent_id uuid not null,
  agent_name text,
  agent_phone text,
  property_name text not null,
  property_type text not null check (property_type in ('house','shop','business_premise','mixed_use')),
  business_category text,
  owner_full_name text not null,
  owner_phone text not null,
  owner_alt_phone text,
  consenting_relation text not null,
  permission_confirmed boolean not null default false,
  owner_payment_method text not null default 'momo_mtn' check (owner_payment_method in ('momo_mtn','momo_airtel','bank')),
  owner_payment_number text not null,
  owner_payment_name text not null,
  gps_latitude numeric(10,7) not null,
  gps_longitude numeric(10,7) not null,
  gps_accuracy_meters numeric(8,2) not null,
  gps_captured_at timestamptz not null default now(),
  district_name text not null,
  county_name text, sub_county_name text, parish_name text,
  village_name text not null,
  plot_or_landmark text,
  foot_traffic text not null default 'medium' check (foot_traffic in ('low','medium','high')),
  road_visibility text, operating_hours text, nearby_landmarks text,
  proposed_surface text, proposed_dimensions text, accessibility_notes text,
  photos jsonb not null default '[]'::jsonb,
  status text not null default 'submitted' check (status in ('draft','submitted','pending','under_review','changes_required','rejected','approved_for_installation','pending_installation','installation_verification','active','temporarily_inactive','payment_on_hold','removal_requested','removed','cancelled')),
  rejection_reason text, review_notes text, reviewed_by uuid, reviewed_at timestamptz,
  installed_at date, installer_name text, installation_photos jsonb not null default '[]'::jsonb,
  verified_by uuid, verified_at timestamptz, verification_notes text,
  activated_at timestamptz, removal_effective_at timestamptz,
  agent_reward_status text not null default 'not_eligible' check (agent_reward_status in ('not_eligible','eligible','pending','processing','paid','failed')),
  agent_reward_tx_ref text, agent_reward_disbursed_at timestamptz, agent_reward_disbursed_by uuid,
  owner_rent_status text not null default 'not_due' check (owner_rent_status in ('not_due','pending','processing','paid','failed')),
  owner_rent_tx_ref text, owner_rent_disbursed_at timestamptz, owner_rent_disbursed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_welile_signages_agent on public.welile_signages(agent_id);
create index idx_welile_signages_status on public.welile_signages(status);

grant select, insert, update on public.welile_signages to authenticated;
grant all on public.welile_signages to service_role;
grant usage on sequence public.welile_signage_seq to authenticated, service_role;

create table public.welile_signage_status_events (
  id uuid primary key default gen_random_uuid(),
  signage_id uuid not null references public.welile_signages(id) on delete restrict,
  from_status text,
  to_status text not null,
  changed_by uuid,
  note text,
  created_at timestamptz not null default now()
);
create index idx_wse_signage on public.welile_signage_status_events(signage_id);
grant select on public.welile_signage_status_events to authenticated;
grant all on public.welile_signage_status_events to service_role;

create or replace function public.welile_signages_ops_ok()
returns boolean language sql stable security definer set search_path = public as $$
  select public._has_enabled_role(auth.uid(), array['agent_ops','operations','manager','super_admin','admin','ceo','coo','cfo'])
$$;
grant execute on function public.welile_signages_ops_ok() to authenticated;

alter table public.welile_signages enable row level security;
alter table public.welile_signage_status_events enable row level security;

create policy mfa_required_for_staff on public.welile_signages as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
create policy mfa_required_for_staff on public.welile_signage_status_events as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

create policy "signages agent insert own" on public.welile_signages for insert to authenticated
  with check (agent_id = (select auth.uid()) and status = 'submitted');
create policy "signages agent read own" on public.welile_signages for select to authenticated
  using (agent_id = (select auth.uid()));
create policy "signages agent update own pending" on public.welile_signages for update to authenticated
  using (agent_id = (select auth.uid()) and status in ('submitted','pending','changes_required'))
  with check (agent_id = (select auth.uid()) and status in ('submitted','pending','cancelled'));
create policy "signages ops read all" on public.welile_signages for select to authenticated
  using ((select public.welile_signages_ops_ok()));
create policy "signages ops update" on public.welile_signages for update to authenticated
  using ((select public.welile_signages_ops_ok())) with check ((select public.welile_signages_ops_ok()));

create policy "signage events read" on public.welile_signage_status_events for select to authenticated
  using ((select public.welile_signages_ops_ok()) or exists (select 1 from public.welile_signages s where s.id = signage_id and s.agent_id = (select auth.uid())));

create or replace function public._welile_signages_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ops boolean := public.welile_signages_ops_ok();
begin
  if tg_op = 'INSERT' then
    new.reference_no := 'SGN-' || to_char(now(), 'YYYY') || '-' || nextval('public.welile_signage_seq');
    new.reviewed_by := null; new.reviewed_at := null; new.verified_by := null; new.verified_at := null;
    new.activated_at := null; new.agent_reward_status := 'not_eligible'; new.owner_rent_status := 'not_due';
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;
  if new.agent_id <> old.agent_id or new.reference_no <> old.reference_no or new.created_at <> old.created_at then
    raise exception 'Signage owner, reference and creation date cannot change';
  end if;
  -- Payout fields move only through a real payment process (none wired yet).
  if (new.agent_reward_status, new.agent_reward_tx_ref, new.agent_reward_disbursed_at, new.owner_rent_status, new.owner_rent_tx_ref, new.owner_rent_disbursed_at)
     is distinct from (old.agent_reward_status, old.agent_reward_tx_ref, old.agent_reward_disbursed_at, old.owner_rent_status, old.owner_rent_tx_ref, old.owner_rent_disbursed_at)
     and current_user not in ('service_role','postgres') then
    if not (new.status = 'active' and old.status <> 'active') then
      raise exception 'Signage payouts can only be recorded by the payment process';
    end if;
  end if;
  if not v_ops then
    if (new.reviewed_by, new.reviewed_at, new.review_notes, new.rejection_reason, new.installed_at, new.installer_name, new.verified_by, new.verified_at, new.verification_notes, new.activated_at)
       is distinct from (old.reviewed_by, old.reviewed_at, old.review_notes, old.rejection_reason, old.installed_at, old.installer_name, old.verified_by, old.verified_at, old.verification_notes, old.activated_at) then
      raise exception 'Only Agent Ops can record review or installation details';
    end if;
  else
    if new.status is distinct from old.status and new.status in ('approved_for_installation','changes_required','rejected') then
      new.reviewed_by := auth.uid(); new.reviewed_at := now();
    end if;
    if new.status = 'active' and old.status <> 'active' then
      new.verified_by := auth.uid(); new.verified_at := now();
      new.activated_at := coalesce(old.activated_at, now());
      new.agent_reward_status := 'eligible'; new.owner_rent_status := 'pending';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger trg_welile_signages_guard before insert or update on public.welile_signages
  for each row execute function public._welile_signages_guard();

create or replace function public._welile_signages_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.welile_signage_status_events(signage_id, from_status, to_status, changed_by, note)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid(),
            case when new.status = 'rejected' then new.rejection_reason else new.review_notes end);
    insert into public.system_events(event_type, entity_type, entity_id, user_id, metadata)
    select 'agent_created'::system_event_type, 'welile_signage', new.id, auth.uid(), jsonb_build_object('signage_status', new.status)
    where false; -- placeholder disabled: no signage event type registered
  end if;
  return new;
end $$;

create trigger trg_welile_signages_audit after insert or update on public.welile_signages
  for each row execute function public._welile_signages_audit();

drop policy if exists pipeline_switches_read on public.pipeline_switches;
create policy pipeline_switches_read on public.pipeline_switches for select to authenticated
  using (key like 'desk_live:%');