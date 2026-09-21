-- =====================================================================
-- LOAN-POLICY-CONFIRM-2026-09-21-H
-- Named, audited route for setting the staff loan policy
-- =====================================================================

create table if not exists public.staff_loan_policy_history (
  id              uuid primary key default gen_random_uuid(),
  monthly_rate    numeric not null,
  interest_method text not null,
  max_months      smallint not null,
  max_principal   numeric,
  deduction_day   smallint not null,
  is_open         boolean not null,
  set_by          uuid not null,
  set_at          timestamptz not null default now(),
  note            text
);

alter table public.staff_loan_policy_history enable row level security;

drop policy if exists staff_loan_policy_history_read on public.staff_loan_policy_history;

create policy staff_loan_policy_history_read
  on public.staff_loan_policy_history for select to authenticated
  using (public.has_role(auth.uid(),'cfo'::app_role)
      or public.has_role(auth.uid(),'ceo'::app_role)
      or public.has_role(auth.uid(),'hr'::app_role));

revoke all on public.staff_loan_policy_history from anon;

create or replace function public.staff_loan_policy_confirm(
  _monthly_rate    numeric,
  _interest_method text,
  _max_months      smallint,
  _max_principal   numeric,
  _open            boolean,
  _note            text
)
returns public.staff_loan_policy
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_row   public.staff_loan_policy%rowtype;
begin
  if v_actor is null then
    raise exception 'Setting loan policy requires a signed-in CFO or CEO. This cannot be done with a service key.';
  end if;
  if not (public.has_role(v_actor,'cfo'::app_role) or public.has_role(v_actor,'ceo'::app_role)) then
    raise exception 'Only the CFO or the CEO may set the staff loan policy.';
  end if;
  if _interest_method not in ('flat','compound') then
    raise exception 'Interest method must be flat or compound.';
  end if;
  if _monthly_rate < 0 or _monthly_rate > 1 then
    raise exception 'Monthly rate must be between 0 and 1.';
  end if;
  if coalesce(_note,'') = '' then
    raise exception 'A note recording the basis of this decision is required.';
  end if;

  update public.staff_loan_policy
     set monthly_rate    = _monthly_rate,
         interest_method = _interest_method,
         max_months      = _max_months,
         max_principal   = _max_principal,
         is_open         = _open,
         confirmed_by    = v_actor,
         confirmed_at    = now(),
         updated_at      = now()
   where id
  returning * into v_row;

  insert into public.staff_loan_policy_history
    (monthly_rate, interest_method, max_months, max_principal, deduction_day, is_open, set_by, note)
  values
    (v_row.monthly_rate, v_row.interest_method, v_row.max_months, v_row.max_principal,
     v_row.deduction_day, v_row.is_open, v_actor, _note);

  return v_row;
end;
$function$;

revoke all on function public.staff_loan_policy_confirm(numeric, text, smallint, numeric, boolean, text) from public, anon;
grant execute on function public.staff_loan_policy_confirm(numeric, text, smallint, numeric, boolean, text) to authenticated;

do $$
declare v_over integer; v_anon boolean; v_conf timestamptz;
begin
  select count(*) into v_over from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='staff_loan_policy_confirm';
  if v_over <> 1 then raise exception 'FAIL A: % overloads of staff_loan_policy_confirm', v_over; end if;

  select has_function_privilege('anon',
    'public.staff_loan_policy_confirm(numeric, text, smallint, numeric, boolean, text)','execute')
    into v_anon;
  if v_anon then raise exception 'FAIL B: anon can execute the policy confirm function'; end if;

  select confirmed_at into v_conf from public.staff_loan_policy where id;
  if v_conf is not null then raise exception 'FAIL C: migration confirmed the policy — it must not'; end if;

  if (select count(*) from public.hr_pay_advances where status = 'ceo_approved') <> 4 then
    raise exception 'FAIL D: advance rows changed — they must not be touched by this task';
  end if;

  raise notice 'LOAN-POLICY-CONFIRM-2026-09-21-H PASSED — policy still unconfirmed, advances untouched';
end $$;

-- =====================================================================
-- END LOAN-POLICY-CONFIRM-2026-09-21-H
-- =====================================================================