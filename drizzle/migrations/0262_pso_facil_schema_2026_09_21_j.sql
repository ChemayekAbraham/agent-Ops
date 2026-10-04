-- =====================================================================
-- PSO-FACIL-SCHEMA-2026-09-21-J
-- Platform Sales Officer facilitation: structures
-- =====================================================================

-- STEP 1: harden the officer definition.
-- It currently matches on the position TITLE string only, so retitling
-- the position would silently empty every PSO report. Match on the key
-- as well. Column list is unchanged; security_invoker is re-declared
-- because CREATE OR REPLACE would otherwise be at risk of losing it.
create or replace view public.v_pso_officers
with (security_invoker = on) as
select s.id as staff_id,
       s.user_id,
       s.staff_ref,
       min(a.started_on) as officer_since
  from hr_staff s
  join hr_assignments a on a.staff_id = s.id and a.ended_on is null
  join hr_positions p on p.id = a.position_id
 where s.active
   and s.ended_on is null
   and (p.key = 'platform_sales_officer'
        or lower(btrim(p.title)) = 'platform sales officer')
 group by s.id, s.user_id, s.staff_ref;

-- STEP 2: facilitation as a request kind, and COO as a terminal stage.
alter table public.staff_requisitions drop constraint if exists staff_requisitions_request_kind_ck;
alter table public.staff_requisitions add  constraint staff_requisitions_request_kind_ck
  check (request_kind in ('requisition','staff_loan','facilitation'));

alter table public.staff_requisitions drop constraint if exists staff_requisitions_final_stage_check;
alter table public.staff_requisitions add  constraint staff_requisitions_final_stage_check
  check (final_stage in ('coo','cfo','ceo'));

-- STEP 3: the plan. What they intend to achieve, stated before the money.
create table if not exists public.staff_facilitation_plan_lines (
  id              uuid primary key default gen_random_uuid(),
  requisition_id  uuid not null references public.staff_requisitions(id) on delete cascade,
  seq             smallint not null,
  purpose         text not null,
  location        text not null,
  amount          numeric not null check (amount > 0),
  created_at      timestamptz not null default now(),
  unique (requisition_id, seq),
  constraint staff_facilitation_plan_purpose_ck  check (btrim(purpose) <> ''),
  constraint staff_facilitation_plan_location_ck check (btrim(location) <> '')
);

alter table public.staff_facilitation_plan_lines enable row level security;

drop policy if exists staff_facilitation_plan_read   on public.staff_facilitation_plan_lines;
drop policy if exists staff_facilitation_plan_write  on public.staff_facilitation_plan_lines;
drop policy if exists staff_facilitation_plan_delete on public.staff_facilitation_plan_lines;

create policy staff_facilitation_plan_read
  on public.staff_facilitation_plan_lines for select to authenticated
  using (exists (select 1 from public.staff_requisitions r
                  where r.id = requisition_id
                    and (r.requester_id = auth.uid() or public.is_welile_staff(auth.uid()))));

create policy staff_facilitation_plan_write
  on public.staff_facilitation_plan_lines for insert to authenticated
  with check (exists (select 1 from public.staff_requisitions r
                       where r.id = requisition_id
                         and r.requester_id = auth.uid()
                         and r.stage = 'coo'
                         and coalesce(r.wallet_credit_status,'') <> 'credited'));

create policy staff_facilitation_plan_delete
  on public.staff_facilitation_plan_lines for delete to authenticated
  using (exists (select 1 from public.staff_requisitions r
                  where r.id = requisition_id
                    and r.requester_id = auth.uid()
                    and r.stage = 'coo'
                    and coalesce(r.wallet_credit_status,'') <> 'credited'));

revoke all on public.staff_facilitation_plan_lines from anon;

-- STEP 4: promissory notes are LINKED to real records, never retyped.
-- One note cannot be claimed against two facilitations.
create table if not exists public.staff_facilitation_notes (
  id                 uuid primary key default gen_random_uuid(),
  requisition_id     uuid not null references public.staff_requisitions(id) on delete cascade,
  promissory_note_id uuid not null references public.promissory_notes(id) on delete restrict,
  linked_by          uuid,
  linked_at          timestamptz not null default now(),
  unique (promissory_note_id)
);

create index if not exists staff_facilitation_notes_req_idx
  on public.staff_facilitation_notes (requisition_id);

alter table public.staff_facilitation_notes enable row level security;

drop policy if exists staff_facilitation_notes_read  on public.staff_facilitation_notes;
drop policy if exists staff_facilitation_notes_write on public.staff_facilitation_notes;

create policy staff_facilitation_notes_read
  on public.staff_facilitation_notes for select to authenticated
  using (exists (select 1 from public.staff_requisitions r
                  where r.id = requisition_id
                    and (r.requester_id = auth.uid() or public.is_welile_staff(auth.uid()))));

create policy staff_facilitation_notes_write
  on public.staff_facilitation_notes for insert to authenticated
  with check (exists (select 1 from public.staff_requisitions r
                       where r.id = requisition_id
                         and r.requester_id = auth.uid()));

revoke all on public.staff_facilitation_notes from anon;

-- STEP 5: accountability fields. Nullable, so the 40 existing reports
-- on ordinary requisitions are unaffected.
alter table public.staff_requisition_usage_reports add column if not exists amount_received         numeric;
alter table public.staff_requisition_usage_reports add column if not exists places_visited          text;
alter table public.staff_requisition_usage_reports add column if not exists activities_carried_out  text;
alter table public.staff_requisition_usage_reports add column if not exists results_achieved        text;

-- STEP 6: assertions.
do $$
declare
  v_officers integer; v_opts text; v_anon boolean; v_kind text; v_final text; v_usage integer;
begin
  select count(*) into v_officers from public.v_pso_officers;
  if v_officers <> 19 then
    raise exception 'FAIL A: officer count changed to % (expected 19) — view rewrite altered the population', v_officers;
  end if;

  select coalesce(c.reloptions::text,'') into v_opts from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='v_pso_officers';
  if v_opts not like '%security_invoker=on%' then
    raise exception 'FAIL B: v_pso_officers lost security_invoker';
  end if;

  select has_table_privilege('anon','public.v_pso_officers','select') into v_anon;
  if v_anon then raise exception 'FAIL C: anon can read v_pso_officers'; end if;

  select pg_get_constraintdef(con.oid) into v_kind from pg_constraint con join pg_class c on c.oid=con.conrelid
   where c.relname='staff_requisitions' and con.conname='staff_requisitions_request_kind_ck';
  if v_kind not like '%facilitation%' then raise exception 'FAIL D: facilitation not a legal request_kind'; end if;

  select pg_get_constraintdef(con.oid) into v_final from pg_constraint con join pg_class c on c.oid=con.conrelid
   where c.relname='staff_requisitions' and con.conname='staff_requisitions_final_stage_check';
  if v_final not like '%coo%' then raise exception 'FAIL E: coo not a legal final_stage'; end if;

  select has_table_privilege('anon','public.staff_facilitation_plan_lines','select') into v_anon;
  if v_anon then raise exception 'FAIL F: anon can read plan lines'; end if;
  select has_table_privilege('anon','public.staff_facilitation_notes','select') into v_anon;
  if v_anon then raise exception 'FAIL G: anon can read facilitation notes'; end if;

  select count(*) into v_usage from public.staff_requisition_usage_reports;
  if v_usage <> 40 then raise exception 'FAIL H: usage reports changed to % (expected 40)', v_usage; end if;

  if (select count(*) from public.staff_requisitions) <> 96 then
    raise exception 'FAIL I: requisition count changed';
  end if;

  raise notice 'PSO-FACIL-SCHEMA-2026-09-21-J PASSED — % officers, 40 usage reports and 96 requisitions untouched', v_officers;
end $$;

-- =====================================================================
-- END PSO-FACIL-SCHEMA-2026-09-21-J
-- =====================================================================