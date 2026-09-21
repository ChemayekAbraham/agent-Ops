-- =====================================================================
-- LOAN-CHAIN-2026-09-21-E
-- Staff loan policy, and database enforcement of the HR -> CEO -> CFO chain
-- =====================================================================

-- STEP 1: single source of truth for loan policy.
create table if not exists public.staff_loan_policy (
  id              boolean primary key default true,
  monthly_rate    numeric  not null,
  interest_method text     not null default 'flat',
  max_months      smallint not null default 12,
  max_principal   numeric,
  deduction_day   smallint not null default 26,
  is_open         boolean  not null default false,
  confirmed_by    uuid,
  confirmed_at    timestamptz,
  updated_at      timestamptz not null default now(),
  constraint staff_loan_policy_singleton check (id),
  constraint staff_loan_policy_method_ck check (interest_method in ('flat','compound')),
  constraint staff_loan_policy_rate_ck   check (monthly_rate >= 0 and monthly_rate <= 1),
  constraint staff_loan_policy_months_ck check (max_months between 1 and 12),
  constraint staff_loan_policy_day_ck    check (deduction_day between 1 and 28)
);

comment on table public.staff_loan_policy is
  'Singleton. The only place a staff loan interest rate is defined. No loan can be originated until confirmed_at is set by a CFO or CEO. Seeded at the rate the eligibility screen previously advertised; this figure is NOT a policy decision and must be confirmed or changed before the first loan.';

insert into public.staff_loan_policy
  (id, monthly_rate, interest_method, max_months, deduction_day, is_open)
values
  (true, 0.28, 'flat', 12, 26, false)
on conflict (id) do nothing;

alter table public.staff_loan_policy enable row level security;

drop policy if exists staff_loan_policy_read  on public.staff_loan_policy;
drop policy if exists staff_loan_policy_write on public.staff_loan_policy;

create policy staff_loan_policy_read
  on public.staff_loan_policy for select to authenticated using (true);

create policy staff_loan_policy_write
  on public.staff_loan_policy for update to authenticated
  using (public.has_role(auth.uid(),'cfo'::app_role) or public.has_role(auth.uid(),'ceo'::app_role))
  with check (public.has_role(auth.uid(),'cfo'::app_role) or public.has_role(auth.uid(),'ceo'::app_role));

revoke all on public.staff_loan_policy from anon;

-- STEP 2: HR decision columns, and 'hr' as a legal stage.
alter table public.staff_requisitions add column if not exists hr_decided_by  uuid;
alter table public.staff_requisitions add column if not exists hr_decided_at  timestamptz;
alter table public.staff_requisitions add column if not exists hr_note        text;

alter table public.staff_requisitions drop constraint if exists staff_requisitions_stage_check;
alter table public.staff_requisitions add  constraint staff_requisitions_stage_check
  check (stage in ('supervisor','hr','coo','cfo','ceo','approved','rejected','returned'));

-- STEP 3: the guard. Fires for service_role too, which RLS does not.
-- Scoped strictly to request_kind = 'staff_loan'. Ordinary requisitions
-- pass through untouched.
create or replace function public.staff_loan_chain_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_pol   public.staff_loan_policy%rowtype;
  v_actor uuid := auth.uid();
begin
  if coalesce(new.request_kind,'requisition') <> 'staff_loan' then
    return new;
  end if;

  select * into v_pol from public.staff_loan_policy where id;

  if tg_op = 'INSERT' then
    if v_pol.confirmed_at is null then
      raise exception 'Staff loans are unavailable: the loan policy has not been confirmed by the CFO or CEO.';
    end if;
    if not v_pol.is_open then
      raise exception 'Staff loan applications are currently closed.';
    end if;
    if coalesce(new.loan_months,0) < 1 or new.loan_months > v_pol.max_months then
      raise exception 'Repayment period must be between 1 and % months.', v_pol.max_months;
    end if;
    if v_pol.max_principal is not null and new.amount > v_pol.max_principal then
      raise exception 'Loan amount exceeds the maximum of %.', v_pol.max_principal;
    end if;

    new.loan_monthly_rate     := v_pol.monthly_rate;
    new.stage                 := 'hr';
    new.current_approver_role := 'hr';
    new.final_stage           := 'ceo';
    new.approved_amount       := null;
    new.hr_decided_by := null;  new.hr_decided_at := null;
    new.ceo_decided_by := null; new.ceo_decided_at := null;
    new.cfo_decided_by := null; new.cfo_decided_at := null;
    new.coo_decided_by := null; new.coo_decided_at := null;
    new.supervisor_decided_by := null; new.supervisor_decided_at := null;
    new.wallet_credit_status := null;
    new.credited_at := null; new.credited_by := null;
    new.decided_at := null;
    return new;
  end if;

  if new.amount is distinct from old.amount
  or new.requester_id is distinct from old.requester_id
  or new.loan_months is distinct from old.loan_months
  or new.loan_monthly_rate is distinct from old.loan_monthly_rate then
    raise exception 'Loan amount, requester, term and rate cannot be changed after submission.';
  end if;

  if new.stage is distinct from old.stage then
    if v_actor is null then
      raise exception 'Loan decisions require a signed-in approver. This action cannot be performed by a service key.';
    end if;
    if v_actor = old.requester_id then
      raise exception 'You cannot decide your own loan request.';
    end if;

    if old.stage = 'hr' and new.stage = 'ceo' then
      if not public.has_role(v_actor,'hr'::app_role) then
        raise exception 'Only HR may give the first approval to a staff loan.';
      end if;
      new.hr_decided_by := v_actor;
      new.hr_decided_at := now();

    elsif old.stage = 'ceo' and new.stage = 'approved' then
      if not public.has_role(v_actor,'ceo'::app_role) then
        raise exception 'Only the CEO may give final approval to a staff loan.';
      end if;
      new.ceo_decided_by := v_actor;
      new.ceo_decided_at := now();
      new.decided_at     := now();

    elsif new.stage = 'rejected' and old.stage in ('hr','ceo') then
      if not (public.has_role(v_actor,'hr'::app_role) or public.has_role(v_actor,'ceo'::app_role)) then
        raise exception 'You do not hold authority to reject a staff loan.';
      end if;
      if coalesce(new.rejection_reason,'') = '' then
        raise exception 'A rejection reason is required.';
      end if;
      new.decided_at := now();

    else
      raise exception 'Illegal staff loan stage transition: % to %.', old.stage, new.stage;
    end if;
  end if;

  -- Disbursement: CFO only, and only once the CEO has approved.
  if coalesce(new.wallet_credit_status,'') = 'credited'
     and coalesce(old.wallet_credit_status,'') is distinct from 'credited' then
    if v_actor is null then
      raise exception 'Loan disbursement requires a signed-in CFO. This action cannot be performed by a service key.';
    end if;
    if not public.has_role(v_actor,'cfo'::app_role) then
      raise exception 'Only the CFO may disburse a staff loan.';
    end if;
    if new.stage <> 'approved' then
      raise exception 'A staff loan cannot be disbursed before CEO approval.';
    end if;
    if v_actor = old.requester_id then
      raise exception 'You cannot disburse your own loan.';
    end if;
    new.cfo_decided_by := v_actor;
    new.cfo_decided_at := now();
    new.credited_by    := v_actor;
    new.credited_at    := now();
  end if;

  return new;
end;
$function$;

drop trigger if exists staff_loan_chain_guard_trg on public.staff_requisitions;

create trigger staff_loan_chain_guard_trg
before insert or update on public.staff_requisitions
for each row execute function public.staff_loan_chain_guard();

-- STEP 4: assertions.
do $$
declare
  v_rows integer; v_conf timestamptz; v_open boolean;
  v_ins boolean; v_upd boolean; v_anon boolean; v_over integer;
  v_untouched integer;
begin
  select count(*) into v_rows from public.staff_loan_policy;
  if v_rows <> 1 then raise exception 'FAIL A: policy table holds % row(s)', v_rows; end if;

  select confirmed_at, is_open into v_conf, v_open from public.staff_loan_policy where id;
  if v_conf is not null then raise exception 'FAIL B: policy seeded as already confirmed'; end if;
  if v_open then raise exception 'FAIL C: policy seeded as open'; end if;

  select has_table_privilege('anon','public.staff_loan_policy','select') into v_anon;
  if v_anon then raise exception 'FAIL D: anon can read the loan policy'; end if;

  select count(*) into v_over from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='staff_loan_chain_guard';
  if v_over <> 1 then raise exception 'FAIL E: % overloads of staff_loan_chain_guard', v_over; end if;

  select bool_or((t.tgtype & 4)>0), bool_or((t.tgtype & 16)>0) into v_ins, v_upd
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  where c.relname='staff_requisitions' and t.tgname='staff_loan_chain_guard_trg' and not t.tgisinternal;
  if not coalesce(v_ins,false) or not coalesce(v_upd,false) then
    raise exception 'FAIL F: chain guard not firing on both INSERT and UPDATE';
  end if;

  select count(*) into v_untouched from public.staff_requisitions
   where coalesce(request_kind,'requisition') = 'requisition';
  if v_untouched <> 96 then
    raise exception 'FAIL G: expected 96 ordinary requisitions untouched, found %', v_untouched;
  end if;

  raise notice 'LOAN-CHAIN-2026-09-21-E PASSED — loans blocked until policy confirmed; % ordinary requisitions untouched', v_untouched;
end $$;

-- =====================================================================
-- END LOAN-CHAIN-2026-09-21-E
-- =====================================================================
