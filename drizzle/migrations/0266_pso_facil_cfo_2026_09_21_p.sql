-- =====================================================================
-- PSO-FACIL-CFO-2026-09-21-P
-- Named disburser, and hand-off from COO approval straight to the CFO
-- =====================================================================

-- STEP 1: named disburser. Four people hold an enabled 'cfo' role, so a
-- role check would let any of them move this money.
create table if not exists public.pso_facilitation_disbursers (
  user_id  uuid primary key,
  added_by uuid,
  added_at timestamptz not null default now(),
  enabled  boolean not null default true,
  note     text
);

insert into public.pso_facilitation_disbursers (user_id, note)
select s.user_id, 'Seeded 2026-09-21: named facilitation disburser.'
  from public.hr_staff s
 where s.staff_ref = 'EMP-00006'
   and s.user_id is not null
on conflict (user_id) do nothing;

alter table public.pso_facilitation_disbursers enable row level security;
drop policy if exists pso_facilitation_disbursers_read on public.pso_facilitation_disbursers;
create policy pso_facilitation_disbursers_read
  on public.pso_facilitation_disbursers for select to authenticated
  using (public.is_welile_staff(auth.uid()));
revoke all on public.pso_facilitation_disbursers from anon;

-- STEP 2: prompts now carry a kind.
alter table public.pso_facilitation_prompts
  add column if not exists kind text not null default 'approval';
alter table public.pso_facilitation_prompts
  drop constraint if exists pso_facilitation_prompts_requisition_id_approver_id_key;
alter table public.pso_facilitation_prompts
  drop constraint if exists pso_facilitation_prompts_uq;
alter table public.pso_facilitation_prompts
  add constraint pso_facilitation_prompts_uq unique (requisition_id, approver_id, kind);
alter table public.pso_facilitation_prompts
  drop constraint if exists pso_facilitation_prompts_kind_ck;
alter table public.pso_facilitation_prompts
  add constraint pso_facilitation_prompts_kind_ck check (kind in ('approval','disbursement'));

-- STEP 3: guard — disbursement restricted to the named disburser.
-- Whole body reproduced; CREATE OR REPLACE replaces everything.
create or replace function public.pso_facilitation_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor   uuid := auth.uid();
  v_is_appr boolean;
  v_is_disb boolean;
  v_stale   integer;
  v_lines   integer;
  v_sum     numeric;
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
                    where a.user_id = v_actor and a.enabled) into v_is_appr;

    if old.stage = 'coo' and new.stage = 'approved' then
      if not v_is_appr then
        raise exception 'Only the named facilitation approver may approve this request.';
      end if;
      select count(*), coalesce(sum(amount),0) into v_lines, v_sum
        from public.staff_facilitation_plan_lines where requisition_id = new.id;
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
      raise exception 'Facilitation disbursement requires a signed-in disburser.';
    end if;
    select exists (select 1 from public.pso_facilitation_disbursers d
                    where d.user_id = v_actor and d.enabled) into v_is_disb;
    if not v_is_disb then
      raise exception 'Only the named facilitation disburser may release these funds.';
    end if;
    if new.stage <> 'approved' then
      raise exception 'Facilitation cannot be disbursed before the COO has approved it.';
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

-- STEP 4: COO approval hands straight to the CFO.
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
    insert into public.pso_facilitation_prompts (requisition_id, approver_id, kind)
    select new.id, a.user_id, 'approval' from public.pso_facilitation_approvers a where a.enabled
    on conflict (requisition_id, approver_id, kind) do nothing;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.stage = 'coo' and new.stage is distinct from 'coo' then
      update public.pso_facilitation_prompts
         set state='resolved', resolved_at=now(), resolution=new.stage
       where requisition_id = new.id and kind='approval' and state <> 'resolved';

      if new.stage = 'approved' then
        insert into public.pso_facilitation_prompts (requisition_id, approver_id, kind)
        select new.id, d.user_id, 'disbursement'
          from public.pso_facilitation_disbursers d where d.enabled
        on conflict (requisition_id, approver_id, kind) do nothing;
      end if;
    end if;

    if coalesce(new.wallet_credit_status,'') = 'credited'
       and coalesce(old.wallet_credit_status,'') is distinct from 'credited' then
      update public.pso_facilitation_prompts
         set state='resolved', resolved_at=now(), resolution='disbursed'
       where requisition_id = new.id and kind='disbursement' and state <> 'resolved';
    end if;
  end if;

  return new;
end;
$function$;

-- STEP 5: one prompt feed, both kinds.
drop function if exists public.pso_facilitation_pending_prompt();

create or replace function public.pso_facilitation_pending_prompt()
returns table(
  prompt_id uuid, kind text, requisition_id uuid, requisition_code text,
  officer_name text, amount numeric, currency text, title text, reason text,
  snooze_count smallint, submitted_at timestamptz
)
language sql stable security definer set search_path to 'public'
as $function$
  select pr.id, pr.kind, r.id, r.requisition_code,
         coalesce(p.full_name, r.requester_name),
         r.amount, r.currency, r.title, r.reason,
         pr.snooze_count, r.created_at
    from public.pso_facilitation_prompts pr
    join public.staff_requisitions r on r.id = pr.requisition_id
    left join public.profiles p on p.id = r.requester_id
   where pr.approver_id = auth.uid()
     and pr.state <> 'resolved'
     and (pr.snooze_until is null or pr.snooze_until <= now())
     and ((pr.kind = 'approval'     and r.stage = 'coo')
       or (pr.kind = 'disbursement' and r.stage = 'approved'
           and coalesce(r.wallet_credit_status,'') <> 'credited'))
   order by r.created_at
   limit 1;
$function$;

revoke all on function public.pso_facilitation_pending_prompt() from public, anon;
grant execute on function public.pso_facilitation_pending_prompt() to authenticated;

-- STEP 6: assertions.
do $$
declare v_d integer; v_ref text; v_def text; v_anon boolean;
begin
  select count(*) into v_d from public.pso_facilitation_disbursers where enabled;
  if v_d <> 1 then raise exception 'FAIL A: % enabled disbursers, expected exactly 1', v_d; end if;

  select s.staff_ref into v_ref from public.pso_facilitation_disbursers d
    join public.hr_staff s on s.user_id=d.user_id where d.enabled;
  raise notice 'Named disburser: %', v_ref;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='pso_facilitation_guard';
  if v_def like '%has_role(v_actor,''cfo''%' then
    raise exception 'FAIL B: guard still uses the cfo role for disbursement';
  end if;
  if v_def not like '%pso_facilitation_disbursers%' then
    raise exception 'FAIL C: guard does not consult the disburser allowlist';
  end if;

  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='pso_facilitation_pending_prompt') <> 1 then
    raise exception 'FAIL D: pending_prompt has the wrong number of overloads';
  end if;

  select has_function_privilege('anon','public.pso_facilitation_pending_prompt()','execute') into v_anon;
  if v_anon then raise exception 'FAIL E: anon can read prompts'; end if;

  if (select count(*) from public.staff_requisitions) <> 96 then
    raise exception 'FAIL F: requisition rows changed';
  end if;

  raise notice 'PSO-FACIL-CFO-2026-09-21-P PASSED — disbursement named, COO approval now raises a CFO prompt';
end $$;

-- =====================================================================
-- END PSO-FACIL-CFO-2026-09-21-P
-- =====================================================================
