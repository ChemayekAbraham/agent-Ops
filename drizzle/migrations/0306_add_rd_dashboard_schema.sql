-- RD-A1: R&D dashboard schema. All objects prefixed rd_. No existing object is altered.

-- ---------- helper predicates ----------
create or replace function public.rd_can_read()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
       public.has_role(auth.uid(), 'rd')
    or public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'cto')
    or ( exists (select 1 from public.staff_permissions sp
                  where sp.user_id = auth.uid()
                    and sp.permitted_dashboard = 'rd'
                    and sp.revoked_at is null)
         and (public.has_role(auth.uid(), 'employee') or public.has_role(auth.uid(), 'ceo')) )
  );
$$;

create or replace function public.rd_is_contributor()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public.has_role(auth.uid(), 'rd');
$$;

create or replace function public.rd_is_lead()
returns boolean language sql stable security definer set search_path = public as $$
  select public.rd_can_read() and exists (
    select 1 from public.hr_assignments a
    join public.hr_positions p on p.id = a.position_id
    where a.staff_id = public.hr_my_staff_id()
      and a.ended_on is null
      and p.key = 'chief_product_officer'
  );
$$;

create or replace function public.rd_me()
returns table(can_read boolean, is_contributor boolean, is_lead boolean, is_ceo boolean, is_cfo boolean)
language sql stable security definer set search_path = public as $$
  select public.rd_can_read(), public.rd_is_contributor(), public.rd_is_lead(),
         coalesce(public.has_role(auth.uid(), 'ceo'), false),
         coalesce(public.has_role(auth.uid(), 'cfo'), false);
$$;

-- ---------- PII guard (phone-number patterns in named text columns) ----------
create or replace function public.rd_pii_guard()
returns trigger language plpgsql as $$
declare
  col text;
  v text;
begin
  foreach col in array TG_ARGV loop
    v := to_jsonb(NEW) ->> col;
    if v is not null and regexp_replace(v, '[\s\-]', '', 'g') ~ '(^|[^0-9])(\+?256|0)?7[0-9]{8}([^0-9]|$)' then
      raise exception 'rd_pii_guard: % looks like it contains a phone number. Link the source record instead.', col;
    end if;
  end loop;
  return NEW;
end $$;

-- ---------- immutability ----------
create or replace function public.rd_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'rd_immutable: rows in % cannot be changed, deleted or truncated', TG_TABLE_NAME;
end $$;

-- ---------- tables ----------
create table public.rd_settings (
  id boolean primary key default true check (id),
  now_cap integer not null default 3 check (now_cap between 1 and 20),
  weekly_question text not null default '' check (char_length(weekly_question) <= 300),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table public.rd_missions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 80),
  problem text not null check (char_length(problem) between 1 and 600),
  constraint_note text,
  bet text,
  evidence text,
  exit_metric_name text,
  exit_metric_baseline numeric,
  exit_metric_target numeric,
  exit_metric_unit text,
  exit_metric_result numeric,
  kill_criteria text,
  stage text not null default 'intake' check (stage in ('intake','frame','build','prove','ship','adopt','kill')),
  horizon text not null default 'next' check (horizon in ('now','next','later')),
  owner_id uuid references auth.users(id),
  deputy_id uuid references auth.users(id),
  sol_days integer check (sol_days > 0),
  started_on date,
  next_gate_on date,
  delay_bucket text check (delay_bucket in ('real_constraint','our_process','our_uncertainty','our_thrash')),
  delay_note text,
  dependency_notes text,
  domains text[] not null default '{}'
    check (domains <@ array['product','model','payments','fraud','security','capital','field_ops','competitor']::text[]),
  ops_ready boolean not null default false,
  ship_approved_by uuid references auth.users(id),
  ship_approved_at timestamptz,
  released_by uuid references auth.users(id),
  released_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rd_missions_owner_after_intake check (stage in ('intake','kill') or owner_id is not null),
  constraint rd_missions_deputy_not_owner check (deputy_id is null or deputy_id is distinct from owner_id)
);
create index rd_missions_stage_idx on public.rd_missions(stage);

create table public.rd_signals (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references auth.users(id) default auth.uid(),
  body text not null check (char_length(body) between 1 and 500),
  why_it_matters text not null check (char_length(why_it_matters) between 1 and 300),
  strength text not null check (strength in ('whisper','pattern','confirmed')),
  domain text not null check (domain in ('product','model','payments','fraud','security','capital','field_ops','competitor')),
  severity text not null default 'p2' check (severity in ('p0','p1','p2')),
  mission_id uuid references public.rd_missions(id),
  status text not null default 'new' check (status in ('new','seen','converted','dismissed')),
  seen_by uuid references auth.users(id),
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rd_signals_author_status_idx on public.rd_signals(author_id, status);

create table public.rd_experiments (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.rd_missions(id),
  hypothesis text not null check (char_length(hypothesis) between 1 and 600),
  cohort text,
  start_on date,
  end_on date,
  guardrail text,
  metric_name text,
  baseline numeric,
  observed numeric,
  result text,
  decision text not null default 'running' check (decision in ('running','ship','iterate','revert','kill')),
  owner_id uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_on is null or start_on is null or end_on >= start_on)
);
create index rd_experiments_mission_idx on public.rd_experiments(mission_id);

create table public.rd_model_versions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version text not null,
  decides text not null check (decides in ('limit','tenor','fraud_flag','collection_path','other')),
  owner_id uuid references auth.users(id),
  training_window text,
  features_note text,
  banned_features_note text,
  source_job text,
  last_drift_check_on date,
  rollback_path text,
  status text not null default 'shadow' check (status in ('shadow','production','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, version),
  constraint rd_model_production_needs_owner_and_rollback
    check (status <> 'production' or (owner_id is not null and coalesce(trim(rollback_path), '') <> ''))
);

create table public.rd_risk_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('rail','vuln','access','kyc','incident','audit')),
  title text not null check (char_length(title) between 1 and 160),
  severity text not null check (severity in ('p0','p1','p2')),
  status text not null default 'open' check (status in ('open','mitigating','closed')),
  owner_id uuid references auth.users(id) default auth.uid(),
  opened_on date not null default ((now() at time zone 'Africa/Kampala')::date),
  due_on date,
  blocks_mission_id uuid references public.rd_missions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rd_risk_items_mission_idx on public.rd_risk_items(blocks_mission_id);

create table public.rd_decisions (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.rd_missions(id),
  decision text not null check (decision in ('ship','kill','pause','adopt')),
  why text not null check (char_length(why) between 1 and 1000),
  belief_that_was_wrong text,
  never_again text,
  artefact_urls text[] not null default '{}',
  decided_by uuid references auth.users(id),
  decided_at timestamptz not null default now()
);
create index rd_decisions_mission_idx on public.rd_decisions(mission_id);

create table public.rd_comments (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.rd_missions(id),
  author_id uuid references auth.users(id) default auth.uid(),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index rd_comments_mission_idx on public.rd_comments(mission_id);

create table public.rd_audit (
  id bigserial primary key,
  actor uuid,
  at timestamptz not null default now(),
  entity text not null,
  entity_id text,
  op text not null,
  field text,
  old_value text,
  new_value text
);
create index rd_audit_entity_idx on public.rd_audit(entity, entity_id);

-- ---------- audit trigger ----------
create or replace function public.rd_audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  k text;
  o jsonb;
  n jsonb;
begin
  if TG_OP = 'INSERT' then
    n := to_jsonb(NEW);
    insert into public.rd_audit(actor, entity, entity_id, op, field, old_value, new_value)
    values (auth.uid(), TG_TABLE_NAME, n ->> 'id', 'insert', null, null, n::text);
    return NEW;
  elsif TG_OP = 'UPDATE' then
    o := to_jsonb(OLD);
    n := to_jsonb(NEW);
    for k in select jsonb_object_keys(n) loop
      if k <> 'updated_at' and (o -> k) is distinct from (n -> k) then
        insert into public.rd_audit(actor, entity, entity_id, op, field, old_value, new_value)
        values (auth.uid(), TG_TABLE_NAME, n ->> 'id', 'update', k, o ->> k, n ->> k);
      end if;
    end loop;
    return NEW;
  else
    o := to_jsonb(OLD);
    insert into public.rd_audit(actor, entity, entity_id, op, field, old_value, new_value)
    values (auth.uid(), TG_TABLE_NAME, o ->> 'id', 'delete', null, o::text, null);
    return OLD;
  end if;
end $$;

-- ---------- mission guard ----------
create or replace function public.rd_missions_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  via boolean := coalesce(current_setting('rd.via_rpc', true), '') = 'on';
begin
  if NEW.owner_id is not null
     and (TG_OP = 'INSERT' or NEW.owner_id is distinct from OLD.owner_id)
     and not public.has_role(NEW.owner_id, 'rd') then
    raise exception 'rd: the owner must hold the R&D role';
  end if;
  if NEW.deputy_id is not null
     and (TG_OP = 'INSERT' or NEW.deputy_id is distinct from OLD.deputy_id)
     and not exists (select 1 from public.hr_staff s where s.user_id = NEW.deputy_id and s.active) then
    raise exception 'rd: the deputy must be an active member of staff';
  end if;

  if TG_OP = 'INSERT' then
    if uid is not null and not via then
      if NEW.stage <> 'intake' then
        raise exception 'rd: new missions start in intake';
      end if;
      if NEW.started_on is not null or NEW.ship_approved_by is not null or NEW.ship_approved_at is not null
         or NEW.released_by is not null or NEW.released_at is not null then
        raise exception 'rd: system-managed fields cannot be set on create';
      end if;
    end if;
    return NEW;
  end if;

  NEW.updated_at := now();
  if uid is null or via then
    return NEW;
  end if;

  if OLD.stage = 'kill' then
    raise exception 'rd: killed missions are read-only';
  end if;
  if NEW.stage is distinct from OLD.stage then
    raise exception 'rd: stage changes go through rd_set_stage';
  end if;
  if (NEW.started_on, NEW.ship_approved_by, NEW.ship_approved_at, NEW.released_by, NEW.released_at, NEW.created_by, NEW.created_at)
     is distinct from
     (OLD.started_on, OLD.ship_approved_by, OLD.ship_approved_at, OLD.released_by, OLD.released_at, OLD.created_by, OLD.created_at) then
    raise exception 'rd: system-managed fields cannot be edited';
  end if;
  if not public.rd_is_lead()
     and (NEW.sol_days, NEW.owner_id, NEW.deputy_id, NEW.horizon, NEW.delay_bucket, NEW.ops_ready)
         is distinct from
         (OLD.sol_days, OLD.owner_id, OLD.deputy_id, OLD.horizon, OLD.delay_bucket, OLD.ops_ready) then
    raise exception 'rd: only the R&D lead can change SoL days, owner, deputy, horizon, delay bucket or ops-ready';
  end if;
  return NEW;
end $$;

-- ---------- signal guard ----------
create or replace function public.rd_signals_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  via boolean := coalesce(current_setting('rd.via_rpc', true), '') = 'on';
  open_count integer;
begin
  if TG_OP = 'INSERT' then
    if NEW.author_id is not null then
      perform pg_advisory_xact_lock(hashtext('rd_signals:' || NEW.author_id::text));
      select count(*) into open_count from public.rd_signals
       where author_id = NEW.author_id and status in ('new','seen');
      if open_count >= 5 then
        raise exception 'rd: you already have 5 open signals. Close one before posting another.';
      end if;
    end if;
    if uid is not null and not via and (NEW.status <> 'new' or NEW.seen_by is not null or NEW.seen_at is not null) then
      raise exception 'rd: new signals start as new';
    end if;
    return NEW;
  end if;

  NEW.updated_at := now();
  if uid is null or via then
    return NEW;
  end if;
  if OLD.status in ('converted','dismissed') and NEW.status is distinct from OLD.status then
    raise exception 'rd: a converted or dismissed signal cannot be reopened';
  end if;
  if NEW.status = 'converted' and OLD.status <> 'converted' then
    raise exception 'rd: convert signals with rd_convert_signal';
  end if;
  if NEW.status in ('seen','dismissed') and OLD.status = 'new' then
    NEW.seen_by := coalesce(NEW.seen_by, uid);
    NEW.seen_at := coalesce(NEW.seen_at, now());
  end if;
  if (NEW.author_id, NEW.body, NEW.why_it_matters, NEW.created_at) is distinct from (OLD.author_id, OLD.body, OLD.why_it_matters, OLD.created_at) then
    raise exception 'rd: a posted signal cannot be rewritten';
  end if;
  return NEW;
end $$;

-- ---------- generic updated_at + model promotion guard ----------
create or replace function public.rd_touch()
returns trigger language plpgsql as $$
begin
  NEW.updated_at := now();
  return NEW;
end $$;

create or replace function public.rd_models_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  NEW.updated_at := now();
  if auth.uid() is not null and NEW.status = 'production'
     and (TG_OP = 'INSERT' or OLD.status is distinct from 'production')
     and not public.rd_is_lead() then
    raise exception 'rd: only the R&D lead can mark a model version production';
  end if;
  return NEW;
end $$;

-- ---------- triggers ----------
create trigger rd_missions_guard_trg before insert or update on public.rd_missions
  for each row execute function public.rd_missions_guard();
create trigger rd_missions_pii_trg before insert or update on public.rd_missions
  for each row execute function public.rd_pii_guard('title','problem','constraint_note','bet','evidence','kill_criteria','delay_note','dependency_notes','exit_metric_name');
create trigger rd_missions_audit_trg after insert or update or delete on public.rd_missions
  for each row execute function public.rd_audit_row();

create trigger rd_signals_guard_trg before insert or update on public.rd_signals
  for each row execute function public.rd_signals_guard();
create trigger rd_signals_pii_trg before insert or update on public.rd_signals
  for each row execute function public.rd_pii_guard('body','why_it_matters');
create trigger rd_signals_audit_trg after insert or update or delete on public.rd_signals
  for each row execute function public.rd_audit_row();

create trigger rd_experiments_touch_trg before update on public.rd_experiments
  for each row execute function public.rd_touch();
create trigger rd_experiments_pii_trg before insert or update on public.rd_experiments
  for each row execute function public.rd_pii_guard('hypothesis','cohort','guardrail','result','metric_name');
create trigger rd_experiments_audit_trg after insert or update or delete on public.rd_experiments
  for each row execute function public.rd_audit_row();

create trigger rd_models_guard_trg before insert or update on public.rd_model_versions
  for each row execute function public.rd_models_guard();
create trigger rd_models_pii_trg before insert or update on public.rd_model_versions
  for each row execute function public.rd_pii_guard('training_window','features_note','banned_features_note','rollback_path');
create trigger rd_models_audit_trg after insert or update or delete on public.rd_model_versions
  for each row execute function public.rd_audit_row();

create trigger rd_risk_touch_trg before update on public.rd_risk_items
  for each row execute function public.rd_touch();
create trigger rd_risk_pii_trg before insert or update on public.rd_risk_items
  for each row execute function public.rd_pii_guard('title');
create trigger rd_risk_audit_trg after insert or update or delete on public.rd_risk_items
  for each row execute function public.rd_audit_row();

create trigger rd_settings_touch_trg before update on public.rd_settings
  for each row execute function public.rd_touch();
create trigger rd_settings_audit_trg after insert or update on public.rd_settings
  for each row execute function public.rd_audit_row();

create trigger rd_decisions_pii_trg before insert on public.rd_decisions
  for each row execute function public.rd_pii_guard('why','belief_that_was_wrong','never_again');
create trigger rd_decisions_audit_trg after insert on public.rd_decisions
  for each row execute function public.rd_audit_row();
create trigger rd_decisions_immutable_trg before update or delete on public.rd_decisions
  for each row execute function public.rd_immutable();
create trigger rd_decisions_no_truncate_trg before truncate on public.rd_decisions
  for each statement execute function public.rd_immutable();

create trigger rd_comments_pii_trg before insert on public.rd_comments
  for each row execute function public.rd_pii_guard('body');
create trigger rd_comments_audit_trg after insert on public.rd_comments
  for each row execute function public.rd_audit_row();
create trigger rd_comments_immutable_trg before update or delete on public.rd_comments
  for each row execute function public.rd_immutable();
create trigger rd_comments_no_truncate_trg before truncate on public.rd_comments
  for each statement execute function public.rd_immutable();

create trigger rd_audit_immutable_trg before update or delete on public.rd_audit
  for each row execute function public.rd_immutable();
create trigger rd_audit_no_truncate_trg before truncate on public.rd_audit
  for each statement execute function public.rd_immutable();

-- ---------- RPCs ----------
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

create or replace function public.rd_decide(p_mission uuid, p_decision text, p_why text,
  p_belief text default null, p_never_again text default null, p_artefacts text[] default '{}')
returns public.rd_missions language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  m public.rd_missions;
begin
  if uid is null or not public.rd_is_lead() then
    raise exception 'rd_decide: only the R&D lead can kill or pause a mission';
  end if;
  if p_decision not in ('kill','pause') then
    raise exception 'rd_decide: ship and adopt are recorded by rd_set_stage';
  end if;
  if coalesce(trim(p_why), '') = '' then
    raise exception 'rd_decide: a reason is required';
  end if;
  if p_decision = 'kill' and (coalesce(trim(p_belief), '') = '' or coalesce(trim(p_never_again), '') = '') then
    raise exception 'rd_decide: killing a mission needs the belief that was wrong and what we will never do again';
  end if;
  select * into m from public.rd_missions where id = p_mission for update;
  if not found then
    raise exception 'rd_decide: mission not found';
  end if;
  if m.stage = 'kill' then
    raise exception 'rd_decide: mission is already killed';
  end if;

  perform set_config('rd.via_rpc', 'on', true);
  if p_decision = 'kill' then
    update public.rd_missions set stage = 'kill' where id = m.id returning * into m;
  else
    update public.rd_missions set horizon = 'later' where id = m.id returning * into m;
  end if;
  perform set_config('rd.via_rpc', 'off', true);

  insert into public.rd_decisions(mission_id, decision, why, belief_that_was_wrong, never_again, artefact_urls, decided_by)
  values (m.id, p_decision, trim(p_why), nullif(trim(coalesce(p_belief, '')), ''), nullif(trim(coalesce(p_never_again, '')), ''),
          coalesce(p_artefacts, '{}'), uid);
  return m;
end $$;

create or replace function public.rd_approve_ship(p_mission uuid)
returns public.rd_missions language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  m public.rd_missions;
begin
  if uid is null or not public.has_role(uid, 'ceo') then
    raise exception 'rd_approve_ship: only the CEO can approve a payments mission to ship';
  end if;
  select * into m from public.rd_missions where id = p_mission for update;
  if not found then
    raise exception 'rd_approve_ship: mission not found';
  end if;
  if not (m.domains @> array['payments']::text[]) then
    raise exception 'rd_approve_ship: only payments missions need CEO approval';
  end if;
  if m.stage <> 'prove' then
    raise exception 'rd_approve_ship: mission must be in prove';
  end if;
  if m.ship_approved_by is not null then
    raise exception 'rd_approve_ship: already approved';
  end if;
  perform set_config('rd.via_rpc', 'on', true);
  update public.rd_missions set ship_approved_by = uid, ship_approved_at = now() where id = m.id returning * into m;
  perform set_config('rd.via_rpc', 'off', true);
  return m;
end $$;

create or replace function public.rd_release(p_mission uuid)
returns public.rd_missions language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  m public.rd_missions;
begin
  if uid is null or not public.has_role(uid, 'cfo') then
    raise exception 'rd_release: only the CFO can release a payments mission';
  end if;
  select * into m from public.rd_missions where id = p_mission for update;
  if not found then
    raise exception 'rd_release: mission not found';
  end if;
  if not (m.domains @> array['payments']::text[]) then
    raise exception 'rd_release: only payments missions need CFO release';
  end if;
  if m.stage <> 'ship' then
    raise exception 'rd_release: mission must be in ship';
  end if;
  if m.ship_approved_by is null then
    raise exception 'rd_release: CEO approval is missing';
  end if;
  if m.ship_approved_by = uid then
    raise exception 'rd_release: the person who approved cannot also release';
  end if;
  if m.released_at is not null then
    raise exception 'rd_release: already released';
  end if;
  perform set_config('rd.via_rpc', 'on', true);
  update public.rd_missions set released_by = uid, released_at = now() where id = m.id returning * into m;
  perform set_config('rd.via_rpc', 'off', true);
  return m;
end $$;

create or replace function public.rd_convert_signal(p_signal uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  s public.rd_signals;
  new_id uuid;
begin
  if uid is null or not public.rd_is_lead() then
    raise exception 'rd_convert_signal: only the R&D lead can convert a signal';
  end if;
  select * into s from public.rd_signals where id = p_signal for update;
  if not found then
    raise exception 'rd_convert_signal: signal not found';
  end if;
  if s.status not in ('new','seen') then
    raise exception 'rd_convert_signal: only open signals can be converted';
  end if;
  perform set_config('rd.via_rpc', 'on', true);
  insert into public.rd_missions(title, problem, domains, created_by, stage, horizon)
  values (left(s.body, 80), left(s.why_it_matters, 600), array[s.domain], uid, 'intake', 'next')
  returning id into new_id;
  update public.rd_signals
     set status = 'converted', mission_id = new_id,
         seen_by = coalesce(seen_by, uid), seen_at = coalesce(seen_at, now())
   where id = s.id;
  perform set_config('rd.via_rpc', 'off', true);
  return new_id;
end $$;

create or replace function public.rd_people()
returns table(user_id uuid, full_name text, staff_ref text, is_rd boolean, is_lead boolean)
language sql stable security definer set search_path = public as $$
  select s.user_id, p.full_name, s.staff_ref,
         public.has_role(s.user_id, 'rd'),
         exists (select 1 from public.hr_assignments a
                 join public.hr_positions hp on hp.id = a.position_id
                 where a.staff_id = s.id and a.ended_on is null and hp.key = 'chief_product_officer')
    from public.hr_staff s
    join public.profiles p on p.id = s.user_id
   where s.active and public.rd_can_read()
   order by p.full_name;
$$;

-- ---------- RLS ----------
alter table public.rd_settings enable row level security;
alter table public.rd_missions enable row level security;
alter table public.rd_signals enable row level security;
alter table public.rd_experiments enable row level security;
alter table public.rd_model_versions enable row level security;
alter table public.rd_risk_items enable row level security;
alter table public.rd_decisions enable row level security;
alter table public.rd_comments enable row level security;
alter table public.rd_audit enable row level security;

create policy rd_settings_read on public.rd_settings for select to authenticated using ((select public.rd_can_read()));
create policy rd_settings_lead_update on public.rd_settings for update to authenticated
  using ((select public.rd_is_lead())) with check ((select public.rd_is_lead()));

create policy rd_missions_read on public.rd_missions for select to authenticated using ((select public.rd_can_read()));
create policy rd_missions_insert on public.rd_missions for insert to authenticated
  with check ((select public.rd_is_contributor()) and stage = 'intake' and created_by = auth.uid());
create policy rd_missions_update on public.rd_missions for update to authenticated
  using ((select public.rd_is_lead()) or ((select public.rd_is_contributor()) and owner_id = auth.uid()))
  with check ((select public.rd_is_lead()) or ((select public.rd_is_contributor()) and owner_id = auth.uid()));

create policy rd_signals_read on public.rd_signals for select to authenticated using ((select public.rd_can_read()));
create policy rd_signals_insert on public.rd_signals for insert to authenticated
  with check ((select public.rd_is_contributor()) and author_id = auth.uid() and status = 'new');
create policy rd_signals_lead_update on public.rd_signals for update to authenticated
  using ((select public.rd_is_lead())) with check ((select public.rd_is_lead()));

create policy rd_experiments_read on public.rd_experiments for select to authenticated using ((select public.rd_can_read()));
create policy rd_experiments_insert on public.rd_experiments for insert to authenticated
  with check ((select public.rd_is_contributor()) and owner_id = auth.uid());
create policy rd_experiments_update on public.rd_experiments for update to authenticated
  using ((select public.rd_is_lead()) or ((select public.rd_is_contributor()) and owner_id = auth.uid()))
  with check ((select public.rd_is_lead()) or ((select public.rd_is_contributor()) and owner_id = auth.uid()));

create policy rd_models_read on public.rd_model_versions for select to authenticated using ((select public.rd_can_read()));
create policy rd_models_insert on public.rd_model_versions for insert to authenticated with check ((select public.rd_is_contributor()));
create policy rd_models_update on public.rd_model_versions for update to authenticated
  using ((select public.rd_is_contributor())) with check ((select public.rd_is_contributor()));

create policy rd_risk_read on public.rd_risk_items for select to authenticated using ((select public.rd_can_read()));
create policy rd_risk_insert on public.rd_risk_items for insert to authenticated with check ((select public.rd_is_contributor()));
create policy rd_risk_update on public.rd_risk_items for update to authenticated
  using ((select public.rd_is_lead()) or ((select public.rd_is_contributor()) and owner_id = auth.uid()))
  with check ((select public.rd_is_lead()) or ((select public.rd_is_contributor()) and owner_id = auth.uid()));

create policy rd_decisions_read on public.rd_decisions for select to authenticated using ((select public.rd_can_read()));

create policy rd_comments_read on public.rd_comments for select to authenticated using ((select public.rd_can_read()));
create policy rd_comments_insert on public.rd_comments for insert to authenticated
  with check ((select public.rd_can_read()) and author_id = auth.uid());

create policy rd_audit_read on public.rd_audit for select to authenticated
  using ((select public.rd_is_lead()) or public.has_role(auth.uid(), 'super_admin'));

-- ---------- function privileges ----------
revoke execute on function public.rd_can_read() from public, anon;
revoke execute on function public.rd_is_contributor() from public, anon;
revoke execute on function public.rd_is_lead() from public, anon;
revoke execute on function public.rd_me() from public, anon;
revoke execute on function public.rd_set_stage(uuid, text, text, boolean) from public, anon;
revoke execute on function public.rd_decide(uuid, text, text, text, text, text[]) from public, anon;
revoke execute on function public.rd_approve_ship(uuid) from public, anon;
revoke execute on function public.rd_release(uuid) from public, anon;
revoke execute on function public.rd_convert_signal(uuid) from public, anon;
revoke execute on function public.rd_people() from public, anon;
revoke execute on function public.rd_audit_row() from public, anon, authenticated;
revoke execute on function public.rd_missions_guard() from public, anon, authenticated;
revoke execute on function public.rd_signals_guard() from public, anon, authenticated;
revoke execute on function public.rd_models_guard() from public, anon, authenticated;
grant execute on function public.rd_can_read() to authenticated;
grant execute on function public.rd_is_contributor() to authenticated;
grant execute on function public.rd_is_lead() to authenticated;
grant execute on function public.rd_me() to authenticated;
grant execute on function public.rd_set_stage(uuid, text, text, boolean) to authenticated;
grant execute on function public.rd_decide(uuid, text, text, text, text, text[]) to authenticated;
grant execute on function public.rd_approve_ship(uuid) to authenticated;
grant execute on function public.rd_release(uuid) to authenticated;
grant execute on function public.rd_convert_signal(uuid) to authenticated;
grant execute on function public.rd_people() to authenticated;

-- ---------- seed ----------
insert into public.rd_settings(id, now_cap, weekly_question) values (true, 3, '');

insert into public.rd_missions(title, problem, domains, stage, horizon) values
('Referral-ring detection',
 'Referral commissions were paid to rings of fake accounts while the bot-referral-ring scan runs every 30 minutes. Why did detection not stop the payouts?',
 array['fraud'], 'intake', 'next'),
('Model inventory',
 'Six scheduled scoring and detection jobs (trust score, credit access limits, credit-limit drift, KYC risk, user risk, receivables forecast) have no registry entry, owner or rollback path.',
 array['model'], 'intake', 'next'),
('Credit access limits: what do they predict?',
 'We recalculate credit access limits daily but have not tested what they predict, including whether scores drift between payday and month-end.',
 array['model','payments'], 'intake', 'next'),
('Ledger correct by construction',
 'Wallet balances depend on repair and reconcile jobs running every 10 to 15 minutes. Can money paths be made atomic instead, including MoMo timeouts and duplicates?',
 array['payments'], 'intake', 'next'),
('Landlord same-day settlement reliability',
 'Landlords expect same-day settlement. We do not yet measure how often it happens or why it fails.',
 array['payments'], 'intake', 'next'),
('Supporter-capital concentration risk',
 'We do not know how concentrated supporter capital is, or what a withdrawal by the largest supporters would do to funding capacity.',
 array['capital'], 'intake', 'next'),
('Agent tenant-verification quality',
 'Agents verify tenants in the field, and near-duplicate phone detection runs hourly. We do not measure how good verification is or where it fails.',
 array['field_ops'], 'intake', 'next');