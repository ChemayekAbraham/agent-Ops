-- RD-V1: products and company values (Hope, Faith, Love) on R&D missions.

create table public.rd_products (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 60),
  active boolean not null default true,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.rd_products enable row level security;
create policy rd_products_read on public.rd_products for select to authenticated using ((select public.rd_can_read()));
create policy rd_products_lead_insert on public.rd_products for insert to authenticated with check ((select public.rd_is_lead()));
create policy rd_products_lead_update on public.rd_products for update to authenticated
  using ((select public.rd_is_lead())) with check ((select public.rd_is_lead()));
create trigger rd_products_pii_trg before insert or update on public.rd_products
  for each row execute function public.rd_pii_guard('name');
create trigger rd_products_audit_trg after insert or update on public.rd_products
  for each row execute function public.rd_audit_row();

alter table public.rd_missions
  add column product_id uuid references public.rd_products(id),
  add column company_value text check (company_value in ('hope','faith','love')),
  add column value_note text check (value_note is null or char_length(value_note) <= 300);

alter table public.rd_settings
  add column value_hope text not null default '' check (char_length(value_hope) <= 300),
  add column value_faith text not null default '' check (char_length(value_faith) <= 300),
  add column value_love text not null default '' check (char_length(value_love) <= 300);

drop trigger rd_missions_pii_trg on public.rd_missions;
create trigger rd_missions_pii_trg before insert or update on public.rd_missions
  for each row execute function public.rd_pii_guard('title','problem','constraint_note','bet','evidence','kill_criteria','delay_note','dependency_notes','exit_metric_name','value_note');

create or replace function public.rd_set_stage(p_mission uuid, p_to text, p_reason text default null, p_force boolean default false)
returns public.rd_missions language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  m public.rd_missions;
  lead boolean := public.rd_is_lead();
  stages constant text[] := array['intake','frame','build','prove','ship','adopt'];
  from_i integer;
  to_i integer;
  pay boolean;
  missing text[] := '{}';
  reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if uid is null then
    raise exception 'rd_set_stage: not permitted';
  end if;
  select * into m from public.rd_missions where id = p_mission for update;
  if not found then
    raise exception 'rd_set_stage: mission not found';
  end if;
  if p_to = 'kill' then
    raise exception 'rd_set_stage: use rd_decide to kill a mission';
  end if;
  if m.stage = 'kill' then
    raise exception 'rd_set_stage: killed missions cannot move';
  end if;
  from_i := array_position(stages, m.stage);
  to_i := array_position(stages, p_to);
  if to_i is null then
    raise exception 'rd_set_stage: unknown stage %', p_to;
  end if;
  if to_i = from_i then
    return m;
  end if;

  if not lead then
    if not (m.stage = 'intake' and p_to = 'frame' and m.owner_id = uid and public.has_role(uid, 'rd') and not p_force) then
      raise exception 'rd_set_stage: only the R&D lead can move a mission from % to %', m.stage, p_to;
    end if;
  end if;
  if p_force and reason is null then
    raise exception 'rd_set_stage: forcing a stage needs a reason';
  end if;
  if to_i < from_i and reason is null then
    raise exception 'rd_set_stage: moving a mission back needs a reason';
  end if;
  if to_i > from_i + 1 and not p_force then
    raise exception 'Cannot skip from % to %', initcap(m.stage), initcap(p_to);
  end if;

  pay := m.domains @> array['payments']::text[];

  if to_i > from_i and not p_force then
    if p_to = 'frame' then
      if m.owner_id is null then missing := missing || 'owner'::text; end if;
      if coalesce(trim(m.problem), '') = '' then missing := missing || 'problem'::text; end if;
    elsif p_to = 'build' then
      if coalesce(trim(m.constraint_note), '') = '' then missing := missing || 'constraint'::text; end if;
      if coalesce(trim(m.bet), '') = '' then missing := missing || 'bet'::text; end if;
      if coalesce(trim(m.kill_criteria), '') = '' then missing := missing || 'kill criteria'::text; end if;
      if coalesce(trim(m.exit_metric_name), '') = '' or m.exit_metric_baseline is null or m.exit_metric_target is null then
        missing := missing || 'exit metric (name, baseline, target)'::text;
      end if;
      if m.sol_days is null then missing := missing || 'SoL days'::text; end if;
      if m.product_id is null then missing := missing || 'product'::text; end if;
      if m.company_value is null then missing := missing || 'company value'::text; end if;
      if coalesce(trim(m.value_note), '') = '' then missing := missing || 'how it serves the value'::text; end if;
    elsif p_to = 'prove' then
      if coalesce(trim(m.evidence), '') = '' then missing := missing || 'evidence'::text; end if;
    elsif p_to = 'ship' then
      if m.exit_metric_result is null then missing := missing || 'exit metric result'::text; end if;
    elsif p_to = 'adopt' then
      if not m.ops_ready then missing := missing || 'ops-ready confirmation'::text; end if;
    end if;
    if array_length(missing, 1) > 0 then
      raise exception 'Cannot leave %: % empty', initcap(m.stage), array_to_string(missing, ', ');
    end if;
  end if;

  if to_i > from_i and p_to in ('ship','adopt') and reason is null then
    raise exception 'Cannot move to %: a reason is required for the decision log', p_to;
  end if;
  if to_i > from_i and to_i >= 5 then
    if exists (select 1 from public.rd_risk_items r
                where r.blocks_mission_id = m.id and r.severity = 'p0' and r.status <> 'closed') then
      raise exception 'Cannot ship: an open P0 risk blocks this mission';
    end if;
    if pay and m.ship_approved_by is null then
      raise exception 'Cannot ship: payments missions need CEO approval first';
    end if;
  end if;
  if to_i > from_i and to_i = 6 and pay and m.released_at is null then
    raise exception 'Cannot adopt: payments missions need CFO release first';
  end if;

  perform set_config('rd.via_rpc', 'on', true);
  update public.rd_missions
     set stage = p_to,
         started_on = case when to_i >= 3 and started_on is null
                           then (now() at time zone 'Africa/Kampala')::date
                           else started_on end
   where id = m.id
   returning * into m;
  perform set_config('rd.via_rpc', 'off', true);

  if to_i > from_i and p_to in ('ship','adopt') then
    insert into public.rd_decisions(mission_id, decision, why, decided_by)
    values (m.id, p_to, reason, uid);
  end if;
  if p_force or to_i < from_i then
    insert into public.rd_audit(actor, entity, entity_id, op, field, old_value, new_value)
    values (uid, 'rd_missions', m.id::text, case when p_force then 'force_stage' else 'stage_back' end, 'reason', null, reason);
  end if;
  return m;
end $$;