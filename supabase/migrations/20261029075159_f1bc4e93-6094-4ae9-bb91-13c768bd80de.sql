alter table public.rent_requests
  add column if not exists pricing_version text not null default 'legacy',
  add column if not exists v360_daily_rate numeric,
  add column if not exists v360_gross numeric,
  add column if not exists v360_receivable numeric,
  add column if not exists v360_paid_days integer not null default 0,
  add column if not exists v360_missed_days integer not null default 0,
  add column if not exists v360_vacant_days integer not null default 0,
  add column if not exists v360_started_on date;

create or replace function public.compute_rent_repayment_v360(p_principal numeric, p_months int default 1)
returns jsonb language plpgsql immutable set search_path = public as $$
declare v_rail numeric; v_gross numeric; v_daily numeric;
begin
  if p_principal is null or p_principal <= 0 then raise exception 'Rent amount must be above zero'; end if;
  if p_months < 1 or p_months > 12 then raise exception 'Months must be between 1 and 12'; end if;
  v_rail := greatest(3500 * p_months, 0.025 * p_months * p_principal);
  v_gross := ceil((p_principal * power(1.15::numeric, p_months) + v_rail) / (0.90 - 0.07 * p_months));
  v_daily := ceil(v_gross / (30 * p_months));
  return jsonb_build_object('pricing_version','v360','principal',p_principal,'gross',v_gross,'daily',v_daily,
    'partner_monthly',round(p_principal*0.15),'partner_12_months',round(p_principal*0.15)*12,
    'agent',round(v_gross*0.10),'rail',v_rail,'welile',round(v_gross*0.07),'receivable_360',360*v_daily);
end $$;
grant execute on function public.compute_rent_repayment_v360(numeric,int) to authenticated, service_role;

create table public.v360_schedules (
  id uuid primary key default gen_random_uuid(),
  rent_request_id uuid not null references public.rent_requests(id),
  kind text not null check (kind in ('partner_returns','landlord_payout')),
  month_no int not null check (month_no between 1 and 12),
  due_on date not null,
  amount numeric not null check (amount >= 0),
  status text not null default 'scheduled' check (status in ('scheduled','covered','covered_by_buffer','paid')),
  buffer_amount numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rent_request_id, kind, month_no)
);
create table public.v360_daily_allocations (
  id uuid primary key default gen_random_uuid(),
  rent_request_id uuid not null references public.rent_requests(id),
  paid_on date not null,
  cash numeric not null check (cash > 0),
  partner_escrow numeric not null, landlord_principal numeric not null, rail numeric not null,
  agent numeric not null, welile numeric not null,
  operating_unit text not null default 'tenant',
  created_by uuid, created_at timestamptz not null default now()
);
create table public.v360_buffer_pool (
  id uuid primary key default gen_random_uuid(),
  movement text not null check (movement in ('seed','draw','replenish')),
  amount numeric not null check (amount > 0),
  rent_request_id uuid references public.rent_requests(id),
  schedule_id uuid references public.v360_schedules(id),
  operating_unit text not null default 'financial_ops',
  note text not null,
  created_by uuid, created_at timestamptz not null default now()
);
create table public.v360_guest_tenants (
  id uuid primary key default gen_random_uuid(),
  rent_request_id uuid not null references public.rent_requests(id),
  guest_tenant_id uuid not null,
  remaining_days int not null,
  reason text not null,
  created_by uuid, created_at timestamptz not null default now()
);
do $$ declare t text; begin
  foreach t in array array['v360_schedules','v360_daily_allocations','v360_buffer_pool','v360_guest_tenants'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public._am_staff_ok()))', t||'_staff_read', t);
    execute format('create policy mfa_required_for_staff on public.%I as restrictive for all to authenticated using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()))', t);
  end loop; end $$;

create or replace function public._v360_maturity(r public.rent_requests) returns date language sql stable set search_path = public as $$
  select r.v360_started_on + 360 + r.v360_missed_days + r.v360_vacant_days $$;

-- Activation: 12 Partner Returns + 12 Landlord payouts + 360-day receivable. Idempotent.
create or replace function public.v360_activate(p_rent_request_id uuid, p_start date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.rent_requests; q jsonb; v_start date;
begin
  if auth.uid() is not null and not (select public._am_staff_ok()) then raise exception 'Not allowed'; end if;
  select * into r from public.rent_requests where id = p_rent_request_id for update;
  if r.id is null or r.pricing_version <> 'v360' then raise exception 'Not a 360-day Rent Plan'; end if;
  if r.v360_started_on is not null then return jsonb_build_object('success',true,'already',true); end if;
  q := public.compute_rent_repayment_v360(r.rent_amount, 1);
  v_start := coalesce(p_start, (now() at time zone 'Africa/Kampala')::date);
  update public.rent_requests set v360_started_on = v_start, v360_gross = (q->>'gross')::numeric,
    v360_daily_rate = (q->>'daily')::numeric, v360_receivable = (q->>'receivable_360')::numeric
   where id = r.id;
  insert into public.v360_schedules (rent_request_id, kind, month_no, due_on, amount)
  select r.id, k, m, v_start + 30*m, case k when 'partner_returns' then (q->>'partner_monthly')::numeric else r.rent_amount end
  from generate_series(1,12) m, unnest(array['partner_returns','landlord_payout']) k
  on conflict do nothing;
  return jsonb_build_object('success',true,'quote',q);
end $$;

-- One daily split for 360-day plans: Partner escrow, Landlord principal, Rail, Agent 10% on cash, Welile 7%.
create or replace function public.post_v360_daily_waterfall(p_rent_request_id uuid, p_cash numeric, p_paid_on date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.rent_requests; v_g numeric; v_partner numeric; v_rail numeric; v_agent numeric; v_welile numeric; v_land numeric;
begin
  if auth.uid() is not null and not (select public._am_staff_ok()) then raise exception 'Not allowed'; end if;
  if p_cash is null or p_cash <= 0 then raise exception 'Amount must be above zero'; end if;
  select * into r from public.rent_requests where id = p_rent_request_id for update;
  if r.id is null or r.pricing_version <> 'v360' or r.v360_started_on is null then raise exception 'Not an active 360-day Rent Plan'; end if;
  v_g := r.v360_gross;
  v_agent := round(p_cash * 0.10);
  v_partner := least(p_cash - v_agent, round(p_cash * round(r.rent_amount*0.15) / v_g));
  v_land := least(p_cash - v_agent - v_partner, round(p_cash * r.rent_amount / v_g));
  v_rail := least(p_cash - v_agent - v_partner - v_land, round(p_cash * greatest(3500, 0.025*r.rent_amount) / v_g));
  v_welile := p_cash - v_agent - v_partner - v_land - v_rail;
  insert into public.v360_daily_allocations (rent_request_id, paid_on, cash, partner_escrow, landlord_principal, rail, agent, welile, created_by)
  values (r.id, p_paid_on, p_cash, v_partner, v_land, v_rail, v_agent, v_welile, auth.uid());
  update public.rent_requests set v360_paid_days = v360_paid_days + floor(p_cash / v360_daily_rate)::int where id = r.id;
  return jsonb_build_object('success',true,'partner',v_partner,'landlord',v_land,'rail',v_rail,'agent',v_agent,'welile',v_welile);
end $$;

-- Day-30: Partner Returns and Landlord payout always covered; shortfall drawn from the buffer reserve.
create or replace function public.v360_day30_settle(p_as_of date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s record; v_as date := coalesce(p_as_of, (now() at time zone 'Africa/Kampala')::date);
  v_cash numeric; v_used numeric; v_short numeric; v_n int := 0;
begin
  if auth.uid() is not null and not (select public._am_staff_ok()) then raise exception 'Not allowed'; end if;
  for s in select sc.* from public.v360_schedules sc where sc.status = 'scheduled' and sc.due_on <= v_as order by sc.due_on, sc.kind desc for update loop
    select coalesce(sum(case when s.kind='partner_returns' then partner_escrow else landlord_principal end),0) into v_cash
      from public.v360_daily_allocations where rent_request_id = s.rent_request_id;
    select coalesce(sum(amount - buffer_amount),0) into v_used from public.v360_schedules
      where rent_request_id = s.rent_request_id and kind = s.kind and status <> 'scheduled';
    v_short := greatest(0, s.amount - greatest(0, v_cash - v_used));
    if v_short > 0 then
      insert into public.v360_buffer_pool (movement, amount, rent_request_id, schedule_id, note)
      values ('draw', v_short, s.rent_request_id, s.id, 'Day-30 cover for '||s.kind||' month '||s.month_no);
    end if;
    update public.v360_schedules set status = case when v_short > 0 then 'covered_by_buffer' else 'covered' end,
      buffer_amount = v_short, updated_at = now() where id = s.id;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('success',true,'settled',v_n);
end $$;

-- Agent: mark a day vacant or missed (adds one day to the end date, never writes off paid days).
create or replace function public.v360_mark_day(p_rent_request_id uuid, p_kind text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.rent_requests;
begin
  if p_kind not in ('vacant','missed') then raise exception 'Unknown day type'; end if;
  if length(coalesce(trim(p_reason),'')) < 10 then raise exception 'Reason must be at least 10 characters'; end if;
  select * into r from public.rent_requests where id = p_rent_request_id for update;
  if r.id is null or r.pricing_version <> 'v360' then raise exception 'Not a 360-day Rent Plan'; end if;
  if (select auth.uid()) is distinct from coalesce(r.assigned_agent_id, r.agent_id) then raise exception 'Only the assigned agent can do this'; end if;
  update public.rent_requests set v360_vacant_days = v360_vacant_days + (p_kind='vacant')::int,
    v360_missed_days = v360_missed_days + (p_kind='missed')::int where id = r.id returning * into r;
  return jsonb_build_object('success',true,'vacant_days',r.v360_vacant_days,'missed_days',r.v360_missed_days,'maturity_on',public._v360_maturity(r));
end $$;

create or replace function public.v360_guest_tenant(p_rent_request_id uuid, p_guest_tenant_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.rent_requests; v_rem int;
begin
  if length(coalesce(trim(p_reason),'')) < 10 then raise exception 'Reason must be at least 10 characters'; end if;
  select * into r from public.rent_requests where id = p_rent_request_id for update;
  if r.id is null or r.pricing_version <> 'v360' then raise exception 'Not a 360-day Rent Plan'; end if;
  if (select auth.uid()) is distinct from coalesce(r.assigned_agent_id, r.agent_id) and not (select public._am_staff_ok()) then raise exception 'Not allowed'; end if;
  v_rem := greatest(0, 360 - r.v360_paid_days);
  insert into public.v360_guest_tenants (rent_request_id, guest_tenant_id, remaining_days, reason, created_by)
  values (r.id, p_guest_tenant_id, v_rem, trim(p_reason), auth.uid());
  return jsonb_build_object('success',true,'remaining_days',v_rem);
end $$;

create or replace function public.v360_plan_summary(p_rent_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r public.rent_requests;
begin
  select * into r from public.rent_requests where id = p_rent_request_id;
  if r.id is null then return null; end if;
  if not ((select public._am_staff_ok()) or (select auth.uid()) in (r.tenant_id, r.agent_id, r.assigned_agent_id, r.landlord_id, r.supporter_id)) then raise exception 'Not allowed'; end if;
  return jsonb_build_object('pricing_version', r.pricing_version, 'daily_rate', r.v360_daily_rate, 'gross', r.v360_gross,
    'partner_monthly', round(r.rent_amount*0.15), 'partner_12_months', round(r.rent_amount*0.15)*12,
    'paid_days', r.v360_paid_days, 'missed_days', r.v360_missed_days, 'vacant_days', r.v360_vacant_days,
    'remaining_receivable', greatest(0, 360 - r.v360_paid_days) * coalesce(r.v360_daily_rate,0),
    'maturity_on', public._v360_maturity(r),
    'buffer_drawn', (select coalesce(sum(amount),0) from public.v360_buffer_pool where rent_request_id = r.id and movement='draw'));
end $$;

revoke all on function public.v360_activate(uuid,date), public.post_v360_daily_waterfall(uuid,numeric,date), public.v360_day30_settle(date),
  public.v360_mark_day(uuid,text,text), public.v360_guest_tenant(uuid,uuid,text), public.v360_plan_summary(uuid), public._v360_maturity(public.rent_requests) from public, anon;
grant execute on function public.v360_activate(uuid,date), public.post_v360_daily_waterfall(uuid,numeric,date), public.v360_day30_settle(date),
  public.v360_mark_day(uuid,text,text), public.v360_guest_tenant(uuid,uuid,text), public.v360_plan_summary(uuid) to authenticated, service_role;
grant execute on function public._v360_maturity(public.rent_requests) to service_role;