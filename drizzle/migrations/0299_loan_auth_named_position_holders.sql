-- =====================================================================
-- LOAN-AUTH-2026-09-22-AC
-- Staff loan authority by named position holder, not by role grant.
-- Chain order is already submit -> HR -> CEO -> CFO. What is wrong is who
-- may act: the guard checks role grants, and one person currently holds
-- hr, ceo and cfo, so a single individual can walk another person's loan
-- through all three stages. This binds each stage to the serving position
-- holder and forbids the same person acting twice on one loan.
-- =====================================================================

create table if not exists public.staff_loan_authorities (
  user_id   uuid not null,
  authority text not null,
  enabled   boolean not null default true,
  added_at  timestamptz not null default now(),
  note      text,
  primary key (user_id, authority),
  constraint staff_loan_authorities_authority_ck check (authority in ('hr','ceo','cfo'))
);

insert into public.staff_loan_authorities (user_id, authority, note)
select s.user_id, x.auth, 'Seeded 2026-09-22 from the live assignment to ' || p.title
  from (values ('hr_lead','hr'), ('ceo','ceo'), ('chief_finance_officer','cfo')) as x(pkey, auth)
  join public.hr_positions   p on p.key = x.pkey
  join public.hr_assignments a on a.position_id = p.id and a.ended_on is null
  join public.hr_staff       s on s.id = a.staff_id and s.active and s.ended_on is null
 where s.user_id is not null
on conflict (user_id, authority) do update set enabled = true;

alter table public.staff_loan_authorities enable row level security;
drop policy if exists staff_loan_authorities_read on public.staff_loan_authorities;
create policy staff_loan_authorities_read
  on public.staff_loan_authorities for select to authenticated
  using (public.is_welile_staff(auth.uid()));
revoke all on public.staff_loan_authorities from anon;

create or replace function public.staff_loan_has_authority(_user_id uuid, _authority text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select exists (select 1 from public.staff_loan_authorities a
                  where a.user_id = _user_id and a.authority = _authority and a.enabled);
$function$;

create or replace function public.staff_loan_chain_guard()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_pol   public.staff_loan_policy%rowtype;
  v_actor uuid := auth.uid();
begin
  if coalesce(new.request_kind,'requisition') <> 'staff_loan' then return new; end if;

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
      if not public.staff_loan_has_authority(v_actor,'hr') then
        raise exception 'Only the serving HR Lead may give the first approval to a staff loan.';
      end if;
      new.hr_decided_by := v_actor;
      new.hr_decided_at := now();

    elsif old.stage = 'ceo' and new.stage = 'approved' then
      if not public.staff_loan_has_authority(v_actor,'ceo') then
        raise exception 'Only the serving Chief Executive Officer may give final approval to a staff loan.';
      end if;
      if v_actor = old.hr_decided_by then
        raise exception 'The same person cannot give both the HR approval and the CEO approval on one loan.';
      end if;
      new.ceo_decided_by := v_actor;
      new.ceo_decided_at := now();
      new.decided_at     := now();

    elsif new.stage = 'rejected' and old.stage in ('hr','ceo') then
      if not (public.staff_loan_has_authority(v_actor,'hr')
           or public.staff_loan_has_authority(v_actor,'ceo')) then
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

  if coalesce(new.wallet_credit_status,'') = 'credited'
     and coalesce(old.wallet_credit_status,'') is distinct from 'credited' then
    if v_actor is null then
      raise exception 'Loan disbursement requires a signed-in Chief Finance Officer.';
    end if;
    if not public.staff_loan_has_authority(v_actor,'cfo') then
      raise exception 'Only the serving Chief Finance Officer may disburse a staff loan.';
    end if;
    if new.stage <> 'approved' then
      raise exception 'A staff loan cannot be disbursed before CEO approval.';
    end if;
    if v_actor = old.requester_id then
      raise exception 'You cannot disburse your own loan.';
    end if;
    if v_actor = old.hr_decided_by or v_actor = old.ceo_decided_by then
      raise exception 'The person who approved a loan cannot also disburse it.';
    end if;
    new.cfo_decided_by := v_actor;
    new.cfo_decided_at := now();
    new.credited_by    := v_actor;
    new.credited_at    := now();
  end if;

  return new;
end;
$function$;

do $$
declare
  v_reqs_before integer;
  v_n integer; v_hr text; v_ceo text; v_cfo text; v_def text; v_anon boolean;
begin
  select count(*) into v_reqs_before from public.staff_requisitions;

  select count(*) into v_n from public.staff_loan_authorities where enabled;
  if v_n <> 3 then raise exception 'FAIL A: % enabled authorities, expected 3', v_n; end if;

  select s.staff_ref into v_hr  from public.staff_loan_authorities a
    join public.hr_staff s on s.user_id=a.user_id where a.authority='hr'  and a.enabled;
  select s.staff_ref into v_ceo from public.staff_loan_authorities a
    join public.hr_staff s on s.user_id=a.user_id where a.authority='ceo' and a.enabled;
  select s.staff_ref into v_cfo from public.staff_loan_authorities a
    join public.hr_staff s on s.user_id=a.user_id where a.authority='cfo' and a.enabled;

  if v_hr is null or v_ceo is null or v_cfo is null then
    raise exception 'FAIL B: a stage has no named holder (hr=%, ceo=%, cfo=%)',
      coalesce(v_hr,'none'), coalesce(v_ceo,'none'), coalesce(v_cfo,'none');
  end if;
  if v_hr = v_ceo or v_hr = v_cfo or v_ceo = v_cfo then
    raise exception 'FAIL C: one person holds more than one loan stage (hr=%, ceo=%, cfo=%)', v_hr, v_ceo, v_cfo;
  end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='staff_loan_chain_guard';
  if v_def like '%has_role(v_actor%' then raise exception 'FAIL D: guard still checks role grants'; end if;
  if v_def not like '%staff_loan_has_authority%' then raise exception 'FAIL E: guard does not use named authorities'; end if;
  if v_def not like '%cannot give both the HR approval%' then raise exception 'FAIL F: separation of duties check missing'; end if;

  select has_table_privilege('anon','public.staff_loan_authorities','select') into v_anon;
  if v_anon then raise exception 'FAIL G: anon can read loan authorities'; end if;

  if not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                  where c.relname='staff_requisitions' and t.tgname='pso_facilitation_guard_trg') then
    raise exception 'FAIL H: the facilitation guard was removed';
  end if;
  if (select count(*) from public.staff_requisitions) <> v_reqs_before then
    raise exception 'FAIL I: requisition rows changed during this migration';
  end if;
  if (select count(*) from public.staff_requisitions where request_kind='facilitation') < 1 then
    raise exception 'FAIL J: the in-flight facilitation request was lost';
  end if;

  raise notice 'LOAN-AUTH-2026-09-22-AC PASSED — HR=%, CEO=%, CFO=%, all distinct', v_hr, v_ceo, v_cfo;
end $$;

-- =====================================================================
-- END LOAN-AUTH-2026-09-22-AC
-- =====================================================================