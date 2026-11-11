-- Welile Schools, phase 1: school onboarding (PRD "Welile Schools PRD and Workflow", screens 1-3).
--
-- A registered school (welile_schools) becomes a Welile Schools PARTNER before any
-- School Fees Plan can be written against it:
--   1. the school agent records the bursar, the school's payout account and the
--      signed partnership agreement            -> welile_school_partnerships
--   2. the agent records the term calendar and the fee per class -> welile_school_terms,
--                                                                   welile_school_fee_structures
--   3. the agent submits; Welile ops approves, asks for changes, or rejects.
--
-- No money moves in this phase. Every write goes through a SECURITY DEFINER function
-- that checks the caller; the tables only grant SELECT to signed-in users.
-- Roles reuse the existing helpers: welile_schools_agent_ok() (agents + ops) and
-- welile_schools_ops_ok() (agent_ops, manager, super_admin, coo, ceo, cto, operations).

-- ─── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.welile_school_partnerships (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null unique references public.welile_schools(id) on delete cascade,
  agent_id              uuid not null,                       -- the school agent who owns the partnership
  status                text not null default 'draft'
                        check (status in ('draft','submitted','changes_requested','approved','rejected','suspended')),
  bursar_name           text,
  bursar_phone          text,
  payout_method         text check (payout_method in ('bank','mobile_money')),
  payout_provider       text,                                -- bank name, or MTN / Airtel
  payout_account_name   text,
  payout_account_number text,
  agreement_path        text,                                -- object path in the school-partnership-docs bucket
  submitted_at          timestamptz,
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  review_note           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.welile_school_terms (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references public.welile_schools(id) on delete cascade,
  name          text not null,
  start_date    date not null,
  end_date      date not null,
  -- School Fees Plans must be cleared two weeks before the term ends.
  plan_due_date date generated always as (end_date - 14) stored,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint welile_school_terms_length check (end_date >= start_date + 28 and end_date <= start_date + 200),
  constraint welile_school_terms_name_unique unique (school_id, name)
);
create index if not exists welile_school_terms_school_idx on public.welile_school_terms (school_id, start_date);

create table if not exists public.welile_school_fee_structures (
  id              uuid primary key default gen_random_uuid(),
  term_id         uuid not null references public.welile_school_terms(id) on delete cascade,
  class_name      text not null,
  boarding_status text not null check (boarding_status in ('day','boarding')),
  amount          numeric(14,2) not null check (amount > 0 and amount <= 50000000),
  created_at      timestamptz not null default now(),
  constraint welile_school_fee_structures_unique unique (term_id, class_name, boarding_status)
);
create index if not exists welile_school_fee_structures_term_idx on public.welile_school_fee_structures (term_id);

-- ─── Row-level security (reads only; writes go through the functions below) ───

alter table public.welile_school_partnerships   enable row level security;
alter table public.welile_school_terms          enable row level security;
alter table public.welile_school_fee_structures enable row level security;

-- The payout account is visible to the owning agent and to ops, not to every agent.
drop policy if exists wspart_select on public.welile_school_partnerships;
create policy wspart_select on public.welile_school_partnerships
  for select to authenticated
  using (agent_id = (select auth.uid()) or (select public.welile_schools_ops_ok()));

-- Term calendars and fees are needed by any agent signing families up at that school.
drop policy if exists wsterm_select on public.welile_school_terms;
create policy wsterm_select on public.welile_school_terms
  for select to authenticated
  using ((select public.welile_schools_agent_ok()));

drop policy if exists wsfee_select on public.welile_school_fee_structures;
create policy wsfee_select on public.welile_school_fee_structures
  for select to authenticated
  using ((select public.welile_schools_agent_ok()));

-- Staff-MFA lock (doc 249) on every new table.
drop policy if exists mfa_required_for_staff on public.welile_school_partnerships;
create policy mfa_required_for_staff on public.welile_school_partnerships
  as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
drop policy if exists mfa_required_for_staff on public.welile_school_terms;
create policy mfa_required_for_staff on public.welile_school_terms
  as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
drop policy if exists mfa_required_for_staff on public.welile_school_fee_structures;
create policy mfa_required_for_staff on public.welile_school_fee_structures
  as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

-- Grants: signed-in users read (RLS decides what), service_role does everything, anon nothing.
revoke all on public.welile_school_partnerships, public.welile_school_terms, public.welile_school_fee_structures from anon, public;
grant select on public.welile_school_partnerships, public.welile_school_terms, public.welile_school_fee_structures to authenticated;
-- Supabase's default privileges still hand authenticated write grants on new tables; take them back.
revoke insert, update, delete, truncate, references, trigger
  on public.welile_school_partnerships, public.welile_school_terms, public.welile_school_fee_structures from authenticated;
grant select, insert, update, delete on public.welile_school_partnerships, public.welile_school_terms, public.welile_school_fee_structures to service_role;

-- ─── Helper: may the caller edit this school's partnership set-up? ───────────
-- The owning agent may edit while the partnership is a draft or sent back for
-- changes; ops may edit at any time. A school with no partnership yet is open to
-- any Welile Schools agent (the first one to save becomes its agent).
create or replace function public.welile_school_partnership_editable(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.welile_schools_ops_ok()
      or (public.welile_schools_agent_ok() and not exists (
            select 1 from public.welile_school_partnerships wp where wp.school_id = p_school_id))
      or exists (
            select 1 from public.welile_school_partnerships wp
             where wp.school_id = p_school_id
               and wp.agent_id = auth.uid()
               and wp.status in ('draft','changes_requested'));
$$;
revoke all on function public.welile_school_partnership_editable(uuid) from public, anon;
grant execute on function public.welile_school_partnership_editable(uuid) to authenticated, service_role;

-- ─── 1. Save the partnership details (bursar, payout account, agreement) ─────
create or replace function public.welile_school_partnership_save(
  p_school_id            uuid,
  p_bursar_name          text,
  p_bursar_phone         text,
  p_payout_method        text,
  p_payout_provider      text,
  p_payout_account_name  text,
  p_payout_account_number text,
  p_agreement_path       text
) returns public.welile_school_partnerships
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.welile_school_partnerships;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (select 1 from public.welile_schools s where s.id = p_school_id) then
    raise exception 'SCHOOL_NOT_FOUND';
  end if;
  if not public.welile_school_partnership_editable(p_school_id) then
    raise exception 'PARTNERSHIP_LOCKED' using hint = 'Only the school''s agent can edit a draft, or ops at any time.';
  end if;
  if p_payout_method is not null and p_payout_method not in ('bank','mobile_money') then
    raise exception 'payout method must be bank or mobile_money';
  end if;
  if nullif(trim(coalesce(p_bursar_phone,'')), '') is not null
     and length(regexp_replace(p_bursar_phone, '\D', '', 'g')) not between 9 and 13 then
    raise exception 'Enter a valid bursar phone number';
  end if;

  insert into public.welile_school_partnerships as wp (
    school_id, agent_id, bursar_name, bursar_phone, payout_method, payout_provider,
    payout_account_name, payout_account_number, agreement_path)
  values (
    p_school_id, v_uid, nullif(trim(p_bursar_name),''), nullif(trim(p_bursar_phone),''), p_payout_method,
    nullif(trim(p_payout_provider),''), nullif(trim(p_payout_account_name),''),
    nullif(trim(p_payout_account_number),''), nullif(trim(p_agreement_path),''))
  on conflict (school_id) do update set
    bursar_name           = excluded.bursar_name,
    bursar_phone          = excluded.bursar_phone,
    payout_method         = excluded.payout_method,
    payout_provider       = excluded.payout_provider,
    payout_account_name   = excluded.payout_account_name,
    payout_account_number = excluded.payout_account_number,
    agreement_path        = coalesce(excluded.agreement_path, wp.agreement_path),
    updated_at            = now()
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.welile_school_partnership_save(uuid,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.welile_school_partnership_save(uuid,text,text,text,text,text,text,text) to authenticated, service_role;

-- ─── 2. Save a term and its fee structure (replaces that term's fees) ────────
-- p_fees = [{"class_name":"S1","boarding_status":"day","amount":850000}, ...]
create or replace function public.welile_school_term_save(
  p_school_id  uuid,
  p_term_id    uuid,
  p_name       text,
  p_start_date date,
  p_end_date   date,
  p_fees       jsonb
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_term uuid;
  v_fee jsonb;
  v_class text;
  v_boarding text;
  v_amount numeric;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.welile_school_partnership_editable(p_school_id) then
    raise exception 'PARTNERSHIP_LOCKED' using hint = 'Only the school''s agent can edit a draft, or ops at any time.';
  end if;
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'Enter the term name'; end if;
  if p_start_date is null or p_end_date is null then raise exception 'Enter the term start and end dates'; end if;
  if p_end_date < p_start_date + 28 then raise exception 'A term must be at least 4 weeks long'; end if;
  if p_end_date > p_start_date + 200 then raise exception 'A term cannot be longer than 200 days'; end if;
  if jsonb_typeof(coalesce(p_fees,'null'::jsonb)) <> 'array' or jsonb_array_length(p_fees) = 0 then
    raise exception 'Add at least one class fee';
  end if;

  if p_term_id is null then
    insert into public.welile_school_terms (school_id, name, start_date, end_date, created_by)
    values (p_school_id, trim(p_name), p_start_date, p_end_date, v_uid)
    returning id into v_term;
  else
    update public.welile_school_terms
       set name = trim(p_name), start_date = p_start_date, end_date = p_end_date, updated_at = now()
     where id = p_term_id and school_id = p_school_id
    returning id into v_term;
    if v_term is null then raise exception 'TERM_NOT_FOUND'; end if;
    delete from public.welile_school_fee_structures where term_id = v_term;
  end if;

  for v_fee in select * from jsonb_array_elements(p_fees) loop
    v_class    := trim(coalesce(v_fee->>'class_name',''));
    v_boarding := coalesce(v_fee->>'boarding_status','day');
    v_amount   := nullif(v_fee->>'amount','')::numeric;
    if length(v_class) = 0 then raise exception 'Every fee needs a class'; end if;
    if v_boarding not in ('day','boarding') then raise exception 'Boarding status must be day or boarding'; end if;
    if v_amount is null or v_amount <= 0 then raise exception 'Fee for % must be more than 0', v_class; end if;
    insert into public.welile_school_fee_structures (term_id, class_name, boarding_status, amount)
    values (v_term, v_class, v_boarding, round(v_amount, 2));
  end loop;

  return v_term;
exception
  when unique_violation then
    raise exception 'A term with this name, or a duplicate class fee, already exists';
end;
$$;
revoke all on function public.welile_school_term_save(uuid,uuid,text,date,date,jsonb) from public, anon;
grant execute on function public.welile_school_term_save(uuid,uuid,text,date,date,jsonb) to authenticated, service_role;

create or replace function public.welile_school_term_delete(p_term_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_school uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select school_id into v_school from public.welile_school_terms where id = p_term_id;
  if v_school is null then raise exception 'TERM_NOT_FOUND'; end if;
  if not public.welile_school_partnership_editable(v_school) then raise exception 'PARTNERSHIP_LOCKED'; end if;
  delete from public.welile_school_terms where id = p_term_id;
end;
$$;
revoke all on function public.welile_school_term_delete(uuid) from public, anon;
grant execute on function public.welile_school_term_delete(uuid) to authenticated, service_role;

-- ─── 3. Submit for ops approval ──────────────────────────────────────────────
create or replace function public.welile_school_partnership_submit(p_school_id uuid)
returns public.welile_school_partnerships
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.welile_school_partnerships;
  v_missing text[] := '{}';
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_row from public.welile_school_partnerships where school_id = p_school_id for update;
  if v_row.id is null then raise exception 'Save the partnership details first'; end if;
  if not (v_row.agent_id = v_uid or public.welile_schools_ops_ok()) then raise exception 'NOT_AUTHORIZED'; end if;
  if v_row.status not in ('draft','changes_requested') then
    raise exception 'PARTNERSHIP_LOCKED' using hint = v_row.status;
  end if;

  if v_row.bursar_name is null or v_row.bursar_phone is null then v_missing := array_append(v_missing, 'bursar contact'); end if;
  if v_row.payout_method is null or v_row.payout_account_name is null or v_row.payout_account_number is null
     or v_row.payout_provider is null then v_missing := array_append(v_missing, 'school payout account'); end if;
  if v_row.agreement_path is null then v_missing := array_append(v_missing, 'signed partnership agreement'); end if;
  if not exists (
       select 1 from public.welile_school_terms t
        where t.school_id = p_school_id and t.end_date >= current_date
          and exists (select 1 from public.welile_school_fee_structures f where f.term_id = t.id)) then
    v_missing := array_append(v_missing, 'a current or upcoming term with fees');
  end if;
  if array_length(v_missing, 1) > 0 then
    raise exception 'Still missing: %', array_to_string(v_missing, ', ');
  end if;

  update public.welile_school_partnerships
     set status = 'submitted', submitted_at = now(), review_note = null, updated_at = now()
   where id = v_row.id
  returning * into v_row;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (v_uid, 'welile_school_partnership_submitted', 'welile_school_partnerships', v_row.id::text,
          jsonb_build_object('school_id', p_school_id));
  return v_row;
end;
$$;
revoke all on function public.welile_school_partnership_submit(uuid) from public, anon;
grant execute on function public.welile_school_partnership_submit(uuid) to authenticated, service_role;

-- ─── 4. Ops review: approve, ask for changes, or reject ──────────────────────
create or replace function public.welile_school_partnership_review(
  p_partnership_id uuid,
  p_decision       text,   -- 'approve' | 'request_changes' | 'reject'
  p_note           text
) returns public.welile_school_partnerships
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.welile_school_partnerships;
  v_new text;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.welile_schools_ops_ok() then raise exception 'NOT_AUTHORIZED'; end if;
  v_new := case p_decision when 'approve' then 'approved'
                           when 'request_changes' then 'changes_requested'
                           when 'reject' then 'rejected' end;
  if v_new is null then raise exception 'decision must be approve, request_changes or reject'; end if;
  if v_new <> 'approved' and length(trim(coalesce(p_note,''))) < 5 then
    raise exception 'Give the agent a reason (at least 5 characters)';
  end if;

  select * into v_row from public.welile_school_partnerships where id = p_partnership_id for update;
  if v_row.id is null then raise exception 'PARTNERSHIP_NOT_FOUND'; end if;
  if v_row.status <> 'submitted' then raise exception 'Only a submitted partnership can be reviewed (it is %)', v_row.status; end if;

  update public.welile_school_partnerships
     set status = v_new, reviewed_by = v_uid, reviewed_at = now(),
         review_note = nullif(trim(p_note),''), updated_at = now()
   where id = v_row.id
  returning * into v_row;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (v_uid, 'welile_school_partnership_' || v_new, 'welile_school_partnerships', v_row.id::text,
          jsonb_build_object('school_id', v_row.school_id, 'note', v_row.review_note));
  return v_row;
end;
$$;
revoke all on function public.welile_school_partnership_review(uuid,text,text) from public, anon;
grant execute on function public.welile_school_partnership_review(uuid,text,text) to authenticated, service_role;

-- ─── Storage: signed partnership agreements ─────────────────────────────────
insert into storage.buckets (id, name, public)
values ('school-partnership-docs', 'school-partnership-docs', false)
on conflict (id) do nothing;

-- Files live at <school_id>/<file>. Agents upload and read; ops read via the same check.
drop policy if exists school_partnership_docs_insert on storage.objects;
create policy school_partnership_docs_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'school-partnership-docs' and (select public.welile_schools_agent_ok()));
drop policy if exists school_partnership_docs_select on storage.objects;
create policy school_partnership_docs_select on storage.objects
  for select to authenticated
  using (bucket_id = 'school-partnership-docs' and (select public.welile_schools_agent_ok()));
