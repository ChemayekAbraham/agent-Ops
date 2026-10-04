-- =====================================================================
-- PSO-FACIL-PROMPT-2026-09-21-L
-- Blocking approval prompt for the named facilitation approver
-- =====================================================================

-- STEP 1: the prompt queue. Kept in the database, not browser state,
-- so a reload cannot dismiss it and every deferral is counted.
create table if not exists public.pso_facilitation_prompts (
  id             uuid primary key default gen_random_uuid(),
  requisition_id uuid not null references public.staff_requisitions(id) on delete cascade,
  approver_id    uuid not null,
  state          text not null default 'pending',
  snooze_until   timestamptz,
  snooze_count   smallint not null default 0,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  resolution     text,
  unique (requisition_id, approver_id),
  constraint pso_facilitation_prompts_state_ck
    check (state in ('pending','snoozed','resolved'))
);

create index if not exists pso_facilitation_prompts_open_idx
  on public.pso_facilitation_prompts (approver_id) where state <> 'resolved';

alter table public.pso_facilitation_prompts enable row level security;

drop policy if exists pso_facilitation_prompts_read on public.pso_facilitation_prompts;

create policy pso_facilitation_prompts_read
  on public.pso_facilitation_prompts for select to authenticated
  using (approver_id = auth.uid() or public.is_welile_staff(auth.uid()));

revoke all on public.pso_facilitation_prompts from anon;

-- STEP 2: raise a prompt for every enabled approver on submission,
-- and resolve it the moment the request leaves stage 'coo'.
create or replace function public.tg_pso_facilitation_prompt()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(new.request_kind,'requisition') <> 'facilitation' then
    return new;
  end if;

  if tg_op = 'INSERT' and new.stage = 'coo' then
    insert into public.pso_facilitation_prompts (requisition_id, approver_id)
    select new.id, a.user_id
      from public.pso_facilitation_approvers a
     where a.enabled
    on conflict (requisition_id, approver_id) do nothing;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.stage = 'coo' and new.stage is distinct from 'coo' then
    update public.pso_facilitation_prompts
       set state       = 'resolved',
           resolved_at = now(),
           resolution  = new.stage
     where requisition_id = new.id and state <> 'resolved';
  end if;

  return new;
end;
$function$;

drop trigger if exists tg_pso_facilitation_prompt_trg on public.staff_requisitions;

create trigger tg_pso_facilitation_prompt_trg
after insert or update on public.staff_requisitions
for each row execute function public.tg_pso_facilitation_prompt();

-- STEP 3: what the app asks on every load. Returns at most one row.
-- A snoozed prompt reappears once snooze_until has passed.
create or replace function public.pso_facilitation_pending_prompt()
returns table(
  prompt_id      uuid,
  requisition_id uuid,
  requisition_code text,
  officer_name   text,
  amount         numeric,
  currency       text,
  title          text,
  reason         text,
  snooze_count   smallint,
  submitted_at   timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select pr.id, r.id, r.requisition_code,
         coalesce(p.full_name, r.requester_name),
         r.amount, r.currency, r.title, r.reason,
         pr.snooze_count, r.created_at
    from public.pso_facilitation_prompts pr
    join public.staff_requisitions r on r.id = pr.requisition_id
    left join public.profiles p on p.id = r.requester_id
   where pr.approver_id = auth.uid()
     and pr.state <> 'resolved'
     and (pr.snooze_until is null or pr.snooze_until <= now())
     and r.stage = 'coo'
   order by r.created_at
   limit 1;
$function$;

-- STEP 4: "Later" defers by two hours and records the deferral.
create or replace function public.pso_facilitation_prompt_snooze(_prompt_id uuid)
returns public.pso_facilitation_prompts
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row public.pso_facilitation_prompts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  update public.pso_facilitation_prompts
     set state        = 'snoozed',
         snooze_until = now() + interval '2 hours',
         snooze_count = snooze_count + 1
   where id = _prompt_id
     and approver_id = auth.uid()
     and state <> 'resolved'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'That approval prompt is not yours, or it has already been dealt with.';
  end if;

  return v_row;
end;
$function$;

revoke all on function public.pso_facilitation_prompt_snooze(uuid) from public, anon;
grant execute on function public.pso_facilitation_prompt_snooze(uuid) to authenticated;
revoke all on function public.pso_facilitation_pending_prompt() from public, anon;
grant execute on function public.pso_facilitation_pending_prompt() to authenticated;

-- STEP 5: assertions.
do $$
declare v_anon boolean; v_over integer; v_ins boolean; v_upd boolean; v_after boolean;
begin
  select count(*) into v_over from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('tg_pso_facilitation_prompt','pso_facilitation_pending_prompt','pso_facilitation_prompt_snooze');
  if v_over <> 3 then raise exception 'FAIL A: expected 3 prompt functions, found %', v_over; end if;

  select bool_or((t.tgtype & 4)>0), bool_or((t.tgtype & 16)>0), bool_or((t.tgtype & 2)=0)
    into v_ins, v_upd, v_after
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  where c.relname='staff_requisitions' and t.tgname='tg_pso_facilitation_prompt_trg' and not t.tgisinternal;
  if not coalesce(v_ins,false) or not coalesce(v_upd,false) then
    raise exception 'FAIL B: prompt trigger not firing on both INSERT and UPDATE';
  end if;
  if not coalesce(v_after,false) then raise exception 'FAIL C: prompt trigger must be AFTER, not BEFORE'; end if;

  select has_table_privilege('anon','public.pso_facilitation_prompts','select') into v_anon;
  if v_anon then raise exception 'FAIL D: anon can read prompts'; end if;

  select has_function_privilege('anon','public.pso_facilitation_prompt_snooze(uuid)','execute') into v_anon;
  if v_anon then raise exception 'FAIL E: anon can snooze prompts'; end if;

  if not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                  where c.relname='staff_requisitions' and t.tgname='pso_facilitation_guard_trg') then
    raise exception 'FAIL F: the facilitation guard was removed';
  end if;
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                  where c.relname='staff_requisitions' and t.tgname='staff_loan_chain_guard_trg') then
    raise exception 'FAIL G: the loan chain guard was removed';
  end if;

  raise notice 'PSO-FACIL-PROMPT-2026-09-21-L PASSED — prompt queue live, Later defers 2 hours';
end $$;

-- =====================================================================
-- END PSO-FACIL-PROMPT-2026-09-21-L
-- =====================================================================
