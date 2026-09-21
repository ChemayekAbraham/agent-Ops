-- =====================================================================
-- LOAN-SCHEDULE-2026-09-21-F
-- Fixed repayment schedule generated at origination
-- =====================================================================

-- STEP 1: the schedule.
create table if not exists public.staff_loan_instalments (
  id          uuid primary key default gen_random_uuid(),
  loan_id     uuid not null references public.staff_loans(id) on delete cascade,
  seq         smallint not null,
  due_on      date not null,
  amount_due  numeric not null check (amount_due > 0),
  amount_paid numeric not null default 0 check (amount_paid >= 0),
  status      text not null default 'due',
  created_at  timestamptz not null default now(),
  constraint staff_loan_instalments_seq_uq check (seq >= 1),
  constraint staff_loan_instalments_status_ck check (status in ('due','partial','paid')),
  unique (loan_id, seq)
);

create index if not exists staff_loan_instalments_due_idx
  on public.staff_loan_instalments (due_on) where status <> 'paid';

alter table public.staff_loan_instalments enable row level security;

drop policy if exists staff_loan_instalments_select on public.staff_loan_instalments;

create policy staff_loan_instalments_select
  on public.staff_loan_instalments for select to authenticated
  using (exists (
    select 1 from public.staff_loans l
    where l.id = loan_id
      and (l.user_id = auth.uid()
           or public.has_role(auth.uid(),'cfo'::app_role)
           or public.has_role(auth.uid(),'ceo'::app_role)
           or public.has_role(auth.uid(),'coo'::app_role)
           or public.has_role(auth.uid(),'hr'::app_role))
  ));

revoke all on public.staff_loan_instalments from anon;

-- STEP 2: origination reads the policy and fixes the total up front.
-- The 0.30 default is removed: the rate can only come from the policy row.
create or replace function public.tg_open_staff_loan_on_credit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_pol       public.staff_loan_policy%rowtype;
  v_principal numeric;
  v_months    integer;
  v_rate      numeric;
  v_interest  numeric;
  v_total     numeric;
  v_inst      numeric;
  v_last      numeric;
  v_loan_id   uuid;
  v_due       date;
  i           integer;
begin
  if coalesce(new.request_kind,'requisition') <> 'staff_loan' then return new; end if;
  if new.wallet_credit_status is distinct from 'credited' then return new; end if;
  if tg_op = 'UPDATE' and old.wallet_credit_status = 'credited' then return new; end if;

  select * into v_pol from public.staff_loan_policy where id;
  if v_pol.confirmed_at is null then
    raise exception 'Cannot originate a staff loan: the loan policy has not been confirmed.';
  end if;

  v_principal := coalesce(new.approved_amount, new.amount);
  v_months    := greatest(1, least(v_pol.max_months, coalesce(new.loan_months,1)));
  v_rate      := coalesce(new.loan_monthly_rate, v_pol.monthly_rate);

  if v_pol.interest_method = 'compound' then
    v_interest := round(v_principal * (power(1 + v_rate, v_months) - 1));
  else
    v_interest := round(v_principal * v_rate * v_months);
  end if;

  v_total := v_principal + v_interest;
  v_inst  := floor(v_total / v_months);
  v_last  := v_total - (v_inst * (v_months - 1));

  v_due := (date_trunc('month', current_date) + (v_months || ' month')::interval)::date
           + (v_pol.deduction_day - 1);

  insert into public.staff_loans (
    requisition_id, user_id, principal, monthly_rate, months,
    outstanding_principal, accrued_interest, interest_charged_total,
    started_on, due_on, last_accrued_on
  ) values (
    new.id, new.requester_id, v_principal, v_rate, v_months,
    v_principal, v_interest, v_interest,
    current_date, v_due, v_due
  )
  on conflict (requisition_id) do nothing
  returning id into v_loan_id;

  if v_loan_id is null then return new; end if;

  for i in 1..v_months loop
    insert into public.staff_loan_instalments (loan_id, seq, due_on, amount_due)
    values (
      v_loan_id,
      i,
      (date_trunc('month', current_date) + (i || ' month')::interval)::date
        + (v_pol.deduction_day - 1),
      case when i = v_months then v_last else v_inst end
    );
  end loop;

  return new;
end;
$function$;

-- STEP 3: interest is fixed at origination, so ongoing accrual must stop.
-- Left as a no-op rather than dropped, because the sweep and any other
-- caller still reference it.
create or replace function public.staff_loan_accrue_interest()
returns table(loans_charged integer, interest_charged numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Interest is computed once at origination and written into the
  -- instalment schedule. Recurring accrual would double-charge.
  return query select 0, 0::numeric;
end;
$function$;

-- STEP 4: the quoted rate and the opened loan now come from one row.
create or replace function public.my_staff_loan_eligibility()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid    uuid := auth.uid();
  v_pol    public.staff_loan_policy%rowtype;
  v_is_emp boolean := false;
  v_active integer := 0;
  v_owed   numeric := 0;
begin
  if v_uid is null then
    return jsonb_build_object('eligible', false, 'reason', 'not_signed_in');
  end if;

  select * into v_pol from public.staff_loan_policy where id;

  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_uid and ur.role = 'employee' and coalesce(ur.enabled, true)
  ) into v_is_emp;

  select count(*), coalesce(sum(outstanding_principal + accrued_interest), 0)
    into v_active, v_owed
    from public.staff_loans
   where user_id = v_uid and status = 'active';

  return jsonb_build_object(
    'eligible', (v_is_emp and v_pol.is_open and v_pol.confirmed_at is not null and v_active = 0),
    'reason', case
        when not v_is_emp then 'not_an_employee'
        when v_pol.confirmed_at is null then 'policy_not_confirmed'
        when not v_pol.is_open then 'applications_closed'
        when v_active > 0 then 'existing_active_loan'
        else null end,
    'monthly_rate', v_pol.monthly_rate,
    'interest_method', v_pol.interest_method,
    'max_months', v_pol.max_months,
    'max_principal', v_pol.max_principal,
    'deduction_day', v_pol.deduction_day,
    'active_loans', v_active,
    'outstanding', v_owed
  );
end;
$function$;

-- STEP 5: assertions.
do $$
declare v_def text; v_over integer; v_anon boolean; v_pol integer;
begin
  select count(*) into v_over from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='tg_open_staff_loan_on_credit';
  if v_over <> 1 then raise exception 'FAIL A: % overloads of origination trigger fn', v_over; end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='tg_open_staff_loan_on_credit';
  if v_def like '%0.30%' then raise exception 'FAIL B: hard-coded 0.30 rate still present'; end if;
  if v_def not like '%staff_loan_instalments%' then raise exception 'FAIL C: origination does not build a schedule'; end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='my_staff_loan_eligibility';
  if v_def like '%0.28%' then raise exception 'FAIL D: hard-coded 0.28 rate still present in eligibility'; end if;

  select has_table_privilege('anon','public.staff_loan_instalments','select') into v_anon;
  if v_anon then raise exception 'FAIL E: anon can read instalments'; end if;

  select count(*) into v_pol from pg_policies
   where schemaname='public' and tablename='staff_loan_instalments';
  if v_pol <> 1 then raise exception 'FAIL F: % policies on instalments, expected 1', v_pol; end if;

  raise notice 'LOAN-SCHEDULE-2026-09-21-F PASSED — schedule table live, rate now single-sourced from staff_loan_policy';
end $$;

-- =====================================================================
-- END LOAN-SCHEDULE-2026-09-21-F
-- =====================================================================
