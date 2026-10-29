create table public.v360_settings (
  id boolean primary key default true check (id),
  new_plans_enabled boolean not null default false,
  updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.v360_settings default values;
grant select on public.v360_settings to authenticated;
grant all on public.v360_settings to service_role;
alter table public.v360_settings enable row level security;
create policy v360_settings_read on public.v360_settings for select to authenticated using (true);
create policy mfa_required_for_staff on public.v360_settings as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

create or replace function public.v360_set_new_plans_enabled(p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not ((select has_role((select auth.uid()),'cfo'::app_role)) or (select has_role((select auth.uid()),'coo'::app_role)) or (select has_role((select auth.uid()),'super_admin'::app_role))) then
    raise exception 'Only CFO, COO or super admin can change this';
  end if;
  update public.v360_settings set new_plans_enabled = p_enabled, updated_by = auth.uid(), updated_at = now();
  return jsonb_build_object('success', true, 'enabled', p_enabled);
end $$;
revoke all on function public.v360_set_new_plans_enabled(boolean) from public, anon;
grant execute on function public.v360_set_new_plans_enabled(boolean) to authenticated;

-- Core helpers without caller checks (called only from triggers and the checked wrappers).
create or replace function public._v360_activate_core(p_rent_request_id uuid, p_start date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.rent_requests; q jsonb;
begin
  select * into r from public.rent_requests where id = p_rent_request_id for update;
  if r.id is null or r.pricing_version <> 'v360' then raise exception 'Not a 360-day Rent Plan'; end if;
  if r.v360_started_on is not null then return jsonb_build_object('success',true,'already',true); end if;
  q := public.compute_rent_repayment_v360(r.rent_amount, 1);
  update public.rent_requests set v360_started_on = p_start, v360_gross = (q->>'gross')::numeric,
    v360_daily_rate = (q->>'daily')::numeric, v360_receivable = (q->>'receivable_360')::numeric where id = r.id;
  insert into public.v360_schedules (rent_request_id, kind, month_no, due_on, amount)
  select r.id, k, m, p_start + 30*m, case k when 'partner_returns' then (q->>'partner_monthly')::numeric else r.rent_amount end
  from generate_series(1,12) m, unnest(array['partner_returns','landlord_payout']) k on conflict do nothing;
  return jsonb_build_object('success',true,'quote',q);
end $$;

create or replace function public.v360_activate(p_rent_request_id uuid, p_start date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not (select public._am_staff_ok()) then raise exception 'Not allowed'; end if;
  return public._v360_activate_core(p_rent_request_id, coalesce(p_start, (now() at time zone 'Africa/Kampala')::date));
end $$;

create or replace function public._v360_waterfall_core(p_rent_request_id uuid, p_cash numeric, p_paid_on date, p_by uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.rent_requests; v_g numeric; v_partner numeric; v_rail numeric; v_agent numeric; v_welile numeric; v_land numeric;
begin
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
  values (r.id, p_paid_on, p_cash, v_partner, v_land, v_rail, v_agent, v_welile, p_by);
  update public.rent_requests set v360_paid_days = v360_paid_days + floor(p_cash / v360_daily_rate)::int where id = r.id;
  return jsonb_build_object('success',true,'partner',v_partner,'landlord',v_land,'rail',v_rail,'agent',v_agent,'welile',v_welile);
end $$;

create or replace function public.post_v360_daily_waterfall(p_rent_request_id uuid, p_cash numeric, p_paid_on date)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not (select public._am_staff_ok()) then raise exception 'Not allowed'; end if;
  return public._v360_waterfall_core(p_rent_request_id, p_cash, p_paid_on, auth.uid());
end $$;

revoke all on function public._v360_activate_core(uuid,date), public._v360_waterfall_core(uuid,numeric,date,uuid) from public, anon, authenticated;
grant execute on function public._v360_activate_core(uuid,date), public._v360_waterfall_core(uuid,numeric,date,uuid) to service_role;

-- New Rent Plans: stamp v360 pricing when the switch is on.
create or replace function public.trg_v360_stamp_new_plan() returns trigger
language plpgsql security definer set search_path = public as $$
declare q jsonb;
begin
  if coalesce((select new_plans_enabled from public.v360_settings), false) and coalesce(new.pricing_version,'legacy') = 'legacy'
     and new.rent_amount > 0 then
    q := public.compute_rent_repayment_v360(new.rent_amount, 1);
    new.pricing_version := 'v360';
    new.v360_gross := (q->>'gross')::numeric;
    new.v360_daily_rate := (q->>'daily')::numeric;
    new.v360_receivable := (q->>'receivable_360')::numeric;
    new.daily_repayment := (q->>'daily')::numeric;
  end if;
  return new;
end $$;
create trigger trg_v360_stamp_new_plan before insert on public.rent_requests
  for each row execute function public.trg_v360_stamp_new_plan();

-- Funding: open the 12-month schedules once.
create or replace function public.trg_v360_activate_on_funding() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.pricing_version = 'v360' and new.v360_started_on is null
     and coalesce(new.funded_at, new.disbursed_at) is not null then
    perform public._v360_activate_core(new.id, (coalesce(new.disbursed_at, new.funded_at) at time zone 'Africa/Kampala')::date);
  end if;
  return null;
end $$;
create trigger trg_v360_activate_on_funding after update of funded_at, disbursed_at on public.rent_requests
  for each row when (new.pricing_version = 'v360') execute function public.trg_v360_activate_on_funding();

-- Collections: record the five-share split for each payment on an active v360 plan.
-- TODO(CFO): real ledger posting of the five shares needs approved ledger categories; until then this is a record only.
create or replace function public.trg_v360_collection_split() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rent_request_id is not null and new.amount > 0 and new.reversed_at is null and exists (
     select 1 from public.rent_requests r where r.id = new.rent_request_id and r.pricing_version = 'v360' and r.v360_started_on is not null) then
    perform public._v360_waterfall_core(new.rent_request_id, new.amount, (new.created_at at time zone 'Africa/Kampala')::date, new.agent_id);
  end if;
  return null;
end $$;
create trigger trg_v360_collection_split after insert on public.agent_collections
  for each row execute function public.trg_v360_collection_split();

revoke all on function public.trg_v360_stamp_new_plan(), public.trg_v360_activate_on_funding(), public.trg_v360_collection_split() from public, anon, authenticated;

-- Daily Day-30 cover at 06:30 Kampala (03:30 UTC). Records only.
select cron.schedule('v360-day30-settle-0630-eat', '30 3 * * *', $c$select public.v360_day30_settle();$c$);