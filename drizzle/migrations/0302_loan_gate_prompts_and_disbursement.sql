-- =====================================================================
-- LOAN-GATE-2026-09-22-AI
-- Blocking approval prompts for staff loans at each stage, and the
-- disbursement function the CFO step needs.
-- =====================================================================

-- STEP 1: ledger category for loan disbursement.
do $mig$
declare v_before integer; v_list text; v_sql text;
begin
  v_before := cardinality(public.ledger_category_allowlist());
  select string_agg(quote_literal(c), ', ' order by c) into v_list
  from (select distinct unnest(public.ledger_category_allowlist()
                               || array['staff_loan_disbursement']) as c) x;
  v_sql := 'create or replace function public.ledger_category_allowlist() '
        || 'returns text[] language sql immutable as $body$ select array['
        || v_list || ']::text[] $body$;';
  execute v_sql;
  if not public.validate_ledger_category('staff_loan_disbursement') then
    raise exception 'FAIL: staff_loan_disbursement not registered';
  end if;
  if not (public.validate_ledger_category('salary_payout')
      and public.validate_ledger_category('staff_loan_repayment')
      and public.validate_ledger_category('facilitation_disbursement')) then
    raise exception 'FAIL: an existing category was lost';
  end if;
  raise notice 'allowlist % -> %', v_before, cardinality(public.ledger_category_allowlist());
end $mig$;

-- STEP 2: the prompt queue.
create table if not exists public.staff_loan_prompts (
  id             uuid primary key default gen_random_uuid(),
  requisition_id uuid not null references public.staff_requisitions(id) on delete cascade,
  approver_id    uuid not null,
  kind           text not null,
  state          text not null default 'pending',
  snooze_until   timestamptz,
  snooze_count   smallint not null default 0,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  resolution     text,
  unique (requisition_id, approver_id, kind),
  constraint staff_loan_prompts_kind_ck  check (kind in ('hr','ceo','cfo')),
  constraint staff_loan_prompts_state_ck check (state in ('pending','snoozed','resolved'))
);

create index if not exists staff_loan_prompts_open_idx
  on public.staff_loan_prompts (approver_id) where state <> 'resolved';

alter table public.staff_loan_prompts enable row level security;
drop policy if exists staff_loan_prompts_read on public.staff_loan_prompts;
create policy staff_loan_prompts_read
  on public.staff_loan_prompts for select to authenticated
  using (approver_id = auth.uid() or public.is_welile_staff(auth.uid()));
revoke all on public.staff_loan_prompts from anon;

-- STEP 3: raise and resolve prompts as the loan moves.
create or replace function public.tg_staff_loan_prompt()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if coalesce(new.request_kind,'requisition') <> 'staff_loan' then return new; end if;

  if tg_op = 'INSERT' and new.stage = 'hr' then
    insert into public.staff_loan_prompts (requisition_id, approver_id, kind)
    select new.id, a.user_id, 'hr'
      from public.staff_loan_authorities a where a.authority='hr' and a.enabled
    on conflict (requisition_id, approver_id, kind) do nothing;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.stage = 'hr' and new.stage is distinct from 'hr' then
      update public.staff_loan_prompts set state='resolved', resolved_at=now(), resolution=new.stage
       where requisition_id=new.id and kind='hr' and state <> 'resolved';
      if new.stage = 'ceo' then
        insert into public.staff_loan_prompts (requisition_id, approver_id, kind)
        select new.id, a.user_id, 'ceo'
          from public.staff_loan_authorities a where a.authority='ceo' and a.enabled
        on conflict (requisition_id, approver_id, kind) do nothing;
      end if;
    end if;

    if old.stage = 'ceo' and new.stage is distinct from 'ceo' then
      update public.staff_loan_prompts set state='resolved', resolved_at=now(), resolution=new.stage
       where requisition_id=new.id and kind='ceo' and state <> 'resolved';
      if new.stage = 'approved' then
        insert into public.staff_loan_prompts (requisition_id, approver_id, kind)
        select new.id, a.user_id, 'cfo'
          from public.staff_loan_authorities a where a.authority='cfo' and a.enabled
        on conflict (requisition_id, approver_id, kind) do nothing;
      end if;
    end if;

    if coalesce(new.wallet_credit_status,'') = 'credited'
       and coalesce(old.wallet_credit_status,'') is distinct from 'credited' then
      update public.staff_loan_prompts set state='resolved', resolved_at=now(), resolution='disbursed'
       where requisition_id=new.id and kind='cfo' and state <> 'resolved';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists tg_staff_loan_prompt_trg on public.staff_requisitions;
create trigger tg_staff_loan_prompt_trg
after insert or update on public.staff_requisitions
for each row execute function public.tg_staff_loan_prompt();

-- STEP 4: what the app asks on every load. At most one row.
create or replace function public.staff_loan_pending_prompt()
returns table(
  prompt_id uuid, kind text, requisition_id uuid, requisition_code text,
  borrower_name text, amount numeric, currency text, months smallint,
  monthly_rate numeric, interest_method text, reason text,
  snooze_count smallint, submitted_at timestamptz
)
language sql stable security definer set search_path to 'public'
as $function$
  select pr.id, pr.kind, r.id, r.requisition_code,
         coalesce(p.full_name, r.requester_name),
         r.amount, r.currency, r.loan_months::smallint,
         r.loan_monthly_rate, pol.interest_method, r.reason,
         pr.snooze_count, r.created_at
    from public.staff_loan_prompts pr
    join public.staff_requisitions r on r.id = pr.requisition_id
    left join public.profiles p on p.id = r.requester_id
    cross join lateral (select interest_method from public.staff_loan_policy where id) pol
   where pr.approver_id = auth.uid()
     and pr.state <> 'resolved'
     and (pr.snooze_until is null or pr.snooze_until <= now())
     and ((pr.kind='hr'  and r.stage='hr')
       or (pr.kind='ceo' and r.stage='ceo')
       or (pr.kind='cfo' and r.stage='approved'
           and coalesce(r.wallet_credit_status,'') <> 'credited'))
   order by r.created_at
   limit 1;
$function$;

create or replace function public.staff_loan_prompt_snooze(_prompt_id uuid)
returns public.staff_loan_prompts
language plpgsql security definer set search_path to 'public'
as $function$
declare v_row public.staff_loan_prompts%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  update public.staff_loan_prompts
     set state='snoozed', snooze_until = now() + interval '2 hours',
         snooze_count = snooze_count + 1
   where id=_prompt_id and approver_id=auth.uid() and state <> 'resolved'
  returning * into v_row;
  if v_row.id is null then
    raise exception 'That approval prompt is not yours, or it has already been dealt with.';
  end if;
  return v_row;
end;
$function$;

-- STEP 5: disbursement — moves the money and records it together.
create or replace function public.staff_loan_disburse(_requisition_id uuid)
returns public.staff_requisitions
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_req   public.staff_requisitions%rowtype;
  v_amt   numeric;
begin
  if v_actor is null then
    raise exception 'Disbursement requires a signed-in Chief Finance Officer.';
  end if;
  if not public.staff_loan_has_authority(v_actor,'cfo') then
    raise exception 'Only the serving Chief Finance Officer may disburse a staff loan.';
  end if;

  select * into v_req from public.staff_requisitions where id=_requisition_id for update;
  if v_req.id is null then raise exception 'That loan request does not exist.'; end if;
  if coalesce(v_req.request_kind,'requisition') <> 'staff_loan' then
    raise exception 'This function disburses staff loans only.';
  end if;
  if v_req.stage <> 'approved' then
    raise exception 'A staff loan cannot be disbursed before CEO approval.';
  end if;
  if coalesce(v_req.wallet_credit_status,'') = 'credited' then
    raise exception 'This loan has already been disbursed.';
  end if;
  if v_actor = v_req.requester_id then raise exception 'You cannot disburse your own loan.'; end if;
  if v_actor = v_req.hr_decided_by or v_actor = v_req.ceo_decided_by then
    raise exception 'The person who approved a loan cannot also disburse it.';
  end if;

  v_amt := coalesce(v_req.approved_amount, v_req.amount);

  perform public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_req.requester_id, 'ledger_scope','platform','direction','cash_out',
        'amount', v_amt, 'category','staff_loan_disbursement','recipient_type','user',
        'classification','production','source_table','staff_requisitions','source_id', v_req.id,
        'description','Staff loan disbursed','currency', coalesce(v_req.currency,'UGX'),
        'transaction_date', current_date),
      jsonb_build_object(
        'user_id', v_req.requester_id, 'ledger_scope','wallet','direction','cash_in',
        'amount', v_amt, 'category','staff_loan_disbursement','recipient_type','user',
        'classification','production','source_table','staff_requisitions','source_id', v_req.id,
        'description','Staff loan received','currency', coalesce(v_req.currency,'UGX'),
        'transaction_date', current_date)
    ),
    idempotency_key := 'staff_loan_' || v_req.id::text
  );

  insert into public.requisition_wallet_credits
    (source_table, requisition_id, requisition_code, user_id, approver_id,
     amount, currency, status, approved_at, credited_at)
  values
    ('staff_requisitions', v_req.id, v_req.requisition_code, v_req.requester_id, v_actor,
     v_amt, coalesce(v_req.currency,'UGX'), 'credited', v_req.ceo_decided_at, now());

  update public.staff_requisitions set wallet_credit_status='credited'
   where id=v_req.id returning * into v_req;

  return v_req;
end;
$function$;

revoke all on function public.staff_loan_pending_prompt() from public, anon;
revoke all on function public.staff_loan_prompt_snooze(uuid) from public, anon;
revoke all on function public.staff_loan_disburse(uuid) from public, anon;
grant execute on function public.staff_loan_pending_prompt() to authenticated;
grant execute on function public.staff_loan_prompt_snooze(uuid) to authenticated;
grant execute on function public.staff_loan_disburse(uuid) to authenticated;

-- STEP 6: raise a prompt for the loan already waiting.
insert into public.staff_loan_prompts (requisition_id, approver_id, kind)
select r.id, a.user_id, 'hr'
  from public.staff_requisitions r
  join public.staff_loan_authorities a on a.authority='hr' and a.enabled
 where r.request_kind='staff_loan' and r.stage='hr'
on conflict (requisition_id, approver_id, kind) do nothing;

do $$
declare v_p integer; v_anon boolean;
begin
  select count(*) into v_p from public.staff_loan_prompts where state='pending';
  if v_p < 1 then raise exception 'FAIL A: no prompt raised for the waiting loan'; end if;

  select has_table_privilege('anon','public.staff_loan_prompts','select') into v_anon;
  if v_anon then raise exception 'FAIL B: anon can read loan prompts'; end if;
  select has_function_privilege('anon','public.staff_loan_disburse(uuid)','execute') into v_anon;
  if v_anon then raise exception 'FAIL C: anon can disburse loans'; end if;

  if not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                  where c.relname='staff_requisitions' and t.tgname='pso_facilitation_guard_trg')
  or not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                  where c.relname='staff_requisitions' and t.tgname='staff_loan_chain_guard_trg') then
    raise exception 'FAIL D: a guard trigger was removed';
  end if;
  if (select count(*) from public.hr_pay_advances) <> 7 then
    raise exception 'FAIL E: advance rows changed';
  end if;

  raise notice 'LOAN-GATE-2026-09-22-AI PASSED — % prompt(s) pending, disbursement function live', v_p;
end $$;

-- =====================================================================
-- END LOAN-GATE-2026-09-22-AI
-- =====================================================================