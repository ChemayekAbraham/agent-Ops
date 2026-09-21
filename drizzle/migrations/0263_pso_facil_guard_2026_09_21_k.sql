-- =====================================================================
-- PSO-FACIL-GUARD-2026-09-21-K
-- Facilitation: named approver, PSO gate, 7-day accountability lock
-- =====================================================================

-- STEP 1: named approver allowlist. Eight people hold an enabled 'coo'
-- role, so a role grant would hand facilitation approval to all of them.
-- Seeded with EMP-00014 only, resolved by staff_ref rather than a
-- hard-coded uuid.
create table if not exists public.pso_facilitation_approvers (
  user_id    uuid primary key,
  added_by   uuid,
  added_at   timestamptz not null default now(),
  enabled    boolean not null default true,
  note       text
);

insert into public.pso_facilitation_approvers (user_id, note)
select s.user_id, 'Seeded 2026-09-21: COO, named facilitation approver.'
  from public.hr_staff s
 where s.staff_ref = 'EMP-00014' and s.user_id is not null
on conflict (user_id) do nothing;

alter table public.pso_facilitation_approvers enable row level security;

drop policy if exists pso_facilitation_approvers_read on public.pso_facilitation_approvers;

create policy pso_facilitation_approvers_read
  on public.pso_facilitation_approvers for select to authenticated
  using (public.is_welile_staff(auth.uid()));

revoke all on public.pso_facilitation_approvers from anon;

-- STEP 2: the guard. Scoped strictly to request_kind = 'facilitation'.
-- Ordinary requisitions and staff loans pass straight through.
create or replace function public.pso_facilitation_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor    uuid := auth.uid();
  v_is_appr  boolean;
  v_stale    integer;
  v_lines    integer;
  v_sum      numeric;
begin
  if coalesce(new.request_kind,'requisition') <> 'facilitation' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if v_actor is null then
      raise exception 'A facilitation request requires a signed-in officer. This cannot be raised with a service key.';
    end if;
    if new.requester_id is distinct from v_actor then
      raise exception 'A facilitation request can only be raised for yourself.';
    end if;
    if not public.pso_is_officer() then
      raise exception 'Only an active Platform Sales Officer may request facilitation.';
    end if;

    select count(*) into v_stale
      from public.staff_requisitions r
     where r.requester_id = v_actor
       and r.request_kind = 'facilitation'
       and r.wallet_credit_status = 'credited'
       and r.credited_at < now() - interval '7 days'
       and not exists (select 1 from public.staff_requisition_usage_reports u
                        where u.requisition_id = r.id);
    if v_stale > 0 then
      raise exception 'You have % earlier facilitation(s) with no accountability report more than 7 days after disbursement. Account for those before requesting more.', v_stale;
    end if;

    new.stage                 := 'coo';
    new.current_approver_role := 'coo';
    new.final_stage           := 'coo';
    new.approved_amount       := null;
    new.hr_decided_by := null;  new.hr_decided_at := null;
    new.coo_decided_by := null; new.coo_decided_at := null;
    new.cfo_decided_by := null; new.cfo_decided_at := null;
    new.ceo_decided_by := null; new.ceo_decided_at := null;
    new.supervisor_decided_by := null; new.supervisor_decided_at := null;
    new.wallet_credit_status := null;
    new.credited_at := null; new.credited_by := null;
    new.decided_at := null;
    return new;
  end if;

  if new.amount is distinct from old.amount
  or new.requester_id is distinct from old.requester_id then
    raise exception 'Facilitation amount and requester cannot be changed after submission.';
  end if;

  if new.stage is distinct from old.stage then
    if v_actor is null then
      raise exception 'Facilitation decisions require a signed-in approver. This cannot be done with a service key.';
    end if;
    if v_actor = old.requester_id then
      raise exception 'You cannot decide your own facilitation request.';
    end if;

    select exists (select 1 from public.pso_facilitation_approvers a
                    where a.user_id = v_actor and a.enabled)
      into v_is_appr;

    if old.stage = 'coo' and new.stage = 'approved' then
      if not v_is_appr then
        raise exception 'Only the named facilitation approver may approve this request.';
      end if;
      select count(*), coalesce(sum(amount),0) into v_lines, v_sum
        from public.staff_facilitation_plan_lines
       where requisition_id = new.id;
      if v_lines = 0 then
        raise exception 'This facilitation has no activity plan. It cannot be approved.';
      end if;
      if v_sum <> new.amount then
        raise exception 'Activity plan totals % but the request is for %. They must match.', v_sum, new.amount;
      end if;
      new.coo_decided_by := v_actor;
      new.coo_decided_at := now();
      new.decided_at     := now();

    elsif new.stage = 'rejected' and old.stage = 'coo' then
      if not v_is_appr then
        raise exception 'Only the named facilitation approver may decline this request.';
      end if;
      if coalesce(new.rejection_reason,'') = '' then
        raise exception 'A reason is required when declining a facilitation request.';
      end if;
      new.coo_decided_by := v_actor;
      new.coo_decided_at := now();
      new.decided_at     := now();

    else
      raise exception 'Illegal facilitation stage transition: % to %.', old.stage, new.stage;
    end if;
  end if;

  if coalesce(new.wallet_credit_status,'') = 'credited'
     and coalesce(old.wallet_credit_status,'') is distinct from 'credited' then
    if v_actor is null then
      raise exception 'Facilitation disbursement requires a signed-in CFO.';
    end if;
    if not public.has_role(v_actor,'cfo'::app_role) then
      raise exception 'Only the CFO may disburse facilitation funds.';
    end if;
    if new.stage <> 'approved' then
      raise exception 'Facilitation cannot be disbursed before it is approved.';
    end if;
    if v_actor = old.requester_id then
      raise exception 'You cannot disburse your own facilitation.';
    end if;
    new.cfo_decided_by := v_actor;
    new.cfo_decided_at := now();
    new.credited_by    := v_actor;
    new.credited_at    := now();
  end if;

  return new;
end;
$function$;

drop trigger if exists pso_facilitation_guard_trg on public.staff_requisitions;

create trigger pso_facilitation_guard_trg
before insert or update on public.staff_requisitions
for each row execute function public.pso_facilitation_guard();

-- STEP 3: accountability report quality, for facilitation only.
create or replace function public.pso_facilitation_report_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r public.staff_requisitions%rowtype;
begin
  select * into r from public.staff_requisitions where id = new.requisition_id;
  if r.id is null or coalesce(r.request_kind,'requisition') <> 'facilitation' then
    return new;
  end if;

  if coalesce(btrim(new.places_visited),'') = ''
  or coalesce(btrim(new.activities_carried_out),'') = ''
  or coalesce(btrim(new.results_achieved),'') = '' then
    raise exception 'Places visited, activities carried out and results achieved are all required on a facilitation accountability report.';
  end if;
  if new.amount_received is null then
    raise exception 'Amount received is required on a facilitation accountability report.';
  end if;
  if new.amount_used is null then
    raise exception 'Amount spent is required on a facilitation accountability report.';
  end if;
  if new.amount_used > new.amount_received then
    raise exception 'Amount spent (%) cannot exceed amount received (%).', new.amount_used, new.amount_received;
  end if;

  return new;
end;
$function$;

drop trigger if exists pso_facilitation_report_guard_trg on public.staff_requisition_usage_reports;

create trigger pso_facilitation_report_guard_trg
before insert or update on public.staff_requisition_usage_reports
for each row execute function public.pso_facilitation_report_guard();

-- STEP 4: assertions.
do $$
declare v_appr integer; v_name text; v_over integer; v_ins boolean; v_upd boolean; v_anon boolean;
begin
  select count(*) into v_appr from public.pso_facilitation_approvers where enabled;
  if v_appr <> 1 then raise exception 'FAIL A: % enabled approvers, expected exactly 1', v_appr; end if;

  select s.staff_ref into v_name
    from public.pso_facilitation_approvers a
    join public.hr_staff s on s.user_id = a.user_id
   where a.enabled;
  if v_name <> 'EMP-00014' then raise exception 'FAIL B: approver is % not EMP-00014', coalesce(v_name,'NULL'); end if;

  select count(*) into v_over from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='pso_facilitation_guard';
  if v_over <> 1 then raise exception 'FAIL C: % overloads of pso_facilitation_guard', v_over; end if;

  select bool_or((t.tgtype & 4)>0), bool_or((t.tgtype & 16)>0) into v_ins, v_upd
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  where c.relname='staff_requisitions' and t.tgname='pso_facilitation_guard_trg' and not t.tgisinternal;
  if not coalesce(v_ins,false) or not coalesce(v_upd,false) then
    raise exception 'FAIL D: facilitation guard not firing on both INSERT and UPDATE';
  end if;

  if not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                  where c.relname='staff_requisitions' and t.tgname='staff_loan_chain_guard_trg') then
    raise exception 'FAIL E: the loan chain guard was removed';
  end if;

  select has_table_privilege('anon','public.pso_facilitation_approvers','select') into v_anon;
  if v_anon then raise exception 'FAIL F: anon can read the approver allowlist'; end if;

  if (select count(*) from public.staff_requisitions) <> 96
  or (select count(*) from public.staff_requisition_usage_reports) <> 40 then
    raise exception 'FAIL G: existing requisition or usage report rows changed';
  end if;

  raise notice 'PSO-FACIL-GUARD-2026-09-21-K PASSED — approver EMP-00014, PSO gate and 7-day lock live';
end $$;

-- =====================================================================
-- END PSO-FACIL-GUARD-2026-09-21-K
-- =====================================================================