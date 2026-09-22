-- =====================================================================
-- LOAN-RATE-CONFIRM-2026-09-22-AG
-- The staff loan rate is the CEO's decision and is final.
--   1. Only the serving Chief Executive Officer may set loan policy.
--      The CFO is removed from that authority.
--   2. The policy is recorded at 28% per month, flat, up to 12 months,
--      attributed to the serving CEO, and applications are opened.
-- =====================================================================

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
  v_ceo   uuid;
  v_row   public.staff_loan_policy%rowtype;
begin
  if v_actor is null then
    raise exception 'Setting loan policy requires a signed-in Chief Executive Officer. This cannot be done with a service key.';
  end if;

  select s.user_id into v_ceo
    from public.hr_staff s
    join public.hr_assignments a on a.staff_id = s.id and a.ended_on is null
    join public.hr_positions   p on p.id = a.position_id
   where p.key = 'ceo' and s.active and s.ended_on is null
   limit 1;

  if v_actor is distinct from v_ceo then
    raise exception 'The staff loan rate is set by the Chief Executive Officer only.';
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

-- Record the decision, attributed to the serving CEO.
update public.staff_loan_policy
   set monthly_rate    = 0.28,
       interest_method = 'flat',
       max_months      = 12,
       is_open         = true,
       confirmed_at    = now(),
       updated_at      = now(),
       confirmed_by    = (
         select s.user_id from public.hr_staff s
           join public.hr_assignments a on a.staff_id = s.id and a.ended_on is null
           join public.hr_positions   p on p.id = a.position_id
          where p.key = 'ceo' and s.active and s.ended_on is null limit 1)
 where id;

insert into public.staff_loan_policy_history
  (monthly_rate, interest_method, max_months, max_principal, deduction_day, is_open, set_by, note)
select p.monthly_rate, p.interest_method, p.max_months, p.max_principal,
       p.deduction_day, p.is_open, p.confirmed_by,
       'Staff loan rate fixed at 28% per month, flat, up to 12 months. '
       || 'Decision of the Chief Executive Officer, recorded 2026-09-22 and applied by migration '
       || 'on the instruction of the Managing Director. No maximum principal set.'
  from public.staff_loan_policy p where p.id;

do $$
declare v_p public.staff_loan_policy%rowtype; v_ceo text; v_by text; v_h integer;
begin
  select * into v_p from public.staff_loan_policy where id;

  if v_p.monthly_rate <> 0.28 then raise exception 'FAIL A: rate is %', v_p.monthly_rate; end if;
  if v_p.interest_method <> 'flat' then raise exception 'FAIL B: method is %', v_p.interest_method; end if;
  if v_p.confirmed_at is null then raise exception 'FAIL C: policy not confirmed'; end if;
  if not v_p.is_open then raise exception 'FAIL D: applications not open'; end if;

  select s.staff_ref into v_ceo from public.hr_staff s
    join public.hr_assignments a on a.staff_id=s.id and a.ended_on is null
    join public.hr_positions   p on p.id=a.position_id
   where p.key='ceo' and s.active and s.ended_on is null;
  select s.staff_ref into v_by from public.hr_staff s where s.user_id = v_p.confirmed_by;
  if v_by is distinct from v_ceo then
    raise exception 'FAIL E: policy attributed to % but the serving CEO is %', coalesce(v_by,'none'), coalesce(v_ceo,'none');
  end if;

  select count(*) into v_h from public.staff_loan_policy_history;
  if v_h < 1 then raise exception 'FAIL F: no history row written'; end if;

  if (select count(*) from public.staff_loans) <> 0 then
    raise exception 'FAIL G: loans exist that should not';
  end if;
  if (select count(*) from public.staff_requisitions where request_kind='facilitation') < 1 then
    raise exception 'FAIL H: the in-flight facilitation was lost';
  end if;

  raise notice 'LOAN-RATE-CONFIRM-2026-09-22-AG PASSED — 28%% per month flat, max 12 months, open, set by %', v_by;
end $$;

-- =====================================================================
-- END LOAN-RATE-CONFIRM-2026-09-22-AG
-- =====================================================================