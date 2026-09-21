-- =====================================================================
-- LOAN-RECOVERY-2026-09-21-G
-- Wallet recovery takes only what is due, and is actually scheduled
-- =====================================================================

-- STEP 1: recovery against the instalment schedule.
-- Previous behaviour swept the entire available wallet balance from the
-- day the loan opened. It now takes only instalments already past due
-- and unpaid, plus arrears, and never more.
create or replace function public.staff_loan_recover_from_wallet(
  p_user_id uuid,
  p_max_amount numeric default null::numeric,
  p_source text default 'wallet_recovery'::text
)
returns table(loan_id uuid, recovered numeric, closed boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r           record;
  ins         record;
  v_available numeric;
  v_due       numeric;
  v_take      numeric;
  v_left      numeric;
  v_alloc     numeric;
  v_interest  numeric;
  v_principal numeric;
  v_idem      text;
  v_open      integer;
begin
  for r in
    select l.* from public.staff_loans l
    where l.user_id = p_user_id
      and l.status = 'active'
      and exists (
        select 1 from public.staff_loan_instalments si
        where si.loan_id = l.id and si.status <> 'paid' and si.due_on <= current_date
      )
    order by l.started_on
  loop
    select coalesce(sum(si.amount_due - si.amount_paid), 0) into v_due
      from public.staff_loan_instalments si
     where si.loan_id = r.id and si.status <> 'paid' and si.due_on <= current_date;

    v_available := greatest(0, coalesce(public.get_user_available_balance(p_user_id), 0));
    if p_max_amount is not null then
      v_available := least(v_available, greatest(0, p_max_amount));
    end if;

    v_take := floor(least(v_available, v_due));
    if v_take <= 0 then continue; end if;

    v_left := v_take;
    for ins in
      select * from public.staff_loan_instalments
       where loan_id = r.id and status <> 'paid' and due_on <= current_date
       order by seq
    loop
      exit when v_left <= 0;
      v_alloc := least(v_left, ins.amount_due - ins.amount_paid);
      update public.staff_loan_instalments
         set amount_paid = amount_paid + v_alloc,
             status = case when ins.amount_paid + v_alloc >= ins.amount_due
                           then 'paid' else 'partial' end
       where id = ins.id;
      v_left := v_left - v_alloc;
    end loop;

    v_interest  := least(v_take, r.accrued_interest);
    v_principal := v_take - v_interest;
    v_idem      := 'staff_loan_recovery_' || r.id::text || '_' || to_char(current_date,'YYYYMMDD');

    perform public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_take, 'category', 'staff_loan_repayment', 'recipient_type', 'user',
          'source_table', 'staff_loans', 'source_id', r.id,
          'description', 'Staff loan instalment', 'currency', 'UGX',
          'transaction_date', current_date,
          'metadata', jsonb_build_object('source','staff_loan_recovery','loan_id', r.id,
                                         'interest_component', v_interest,
                                         'principal_component', v_principal)
        ),
        jsonb_build_object(
          'user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_take, 'category', 'staff_loan_repayment', 'recipient_type', 'operational_wallet',
          'source_table', 'staff_loans', 'source_id', r.id,
          'description', 'Staff loan instalment received', 'currency', 'UGX',
          'transaction_date', current_date,
          'metadata', jsonb_build_object('source','staff_loan_recovery','loan_id', r.id)
        )
      ),
      idempotency_key := v_idem
    );

    insert into public.staff_loan_repayments
      (loan_id, user_id, amount, interest_component, principal_component, source)
    values
      (r.id, p_user_id, v_take, v_interest, v_principal, coalesce(p_source,'wallet_recovery'));

    select count(*) into v_open
      from public.staff_loan_instalments
     where loan_id = r.id and status <> 'paid';

    update public.staff_loans
       set accrued_interest      = greatest(0, accrued_interest - v_interest),
           outstanding_principal = greatest(0, outstanding_principal - v_principal),
           total_repaid          = total_repaid + v_take,
           status       = case when v_open = 0 then 'completed' else status end,
           completed_at = case when v_open = 0 then now() else completed_at end,
           updated_at   = now()
     where id = r.id;

    return query select r.id, v_take, (v_open = 0);
  end loop;
end;
$function$;

-- STEP 2: sweep only borrowers with something actually due.
-- The accrual call is removed: interest is fixed at origination.
create or replace function public.sweep_staff_loan_recovery()
returns table(users_swept integer, total_recovered numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  u       record;
  v_users integer := 0;
  v_total numeric := 0;
  v_sum   numeric;
begin
  for u in
    select distinct l.user_id
      from public.staff_loans l
     where l.status = 'active'
       and exists (
         select 1 from public.staff_loan_instalments si
         where si.loan_id = l.id and si.status <> 'paid' and si.due_on <= current_date
       )
  loop
    select coalesce(sum(recovered), 0) into v_sum
      from public.staff_loan_recover_from_wallet(u.user_id);
    if v_sum > 0 then
      v_users := v_users + 1;
      v_total := v_total + v_sum;
    end if;
  end loop;
  return query select v_users, v_total;
end;
$function$;

-- STEP 3: schedule it. Daily at 04:00 UTC = 07:00 EAT, so the 26th is
-- collected and any arrears are picked up as soon as money lands.
select cron.unschedule('staff-loan-recovery-daily')
 where exists (select 1 from cron.job where jobname = 'staff-loan-recovery-daily');

select cron.schedule(
  'staff-loan-recovery-daily',
  '0 4 * * *',
  $cron$ SELECT public.sweep_staff_loan_recovery(); $cron$
);

-- STEP 4: assertions.
do $$
declare v_def text; v_jobs integer; v_sched text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='staff_loan_recover_from_wallet';
  if v_def like '%agent_repayment%' then
    raise exception 'FAIL A: repayments still posting under agent_repayment';
  end if;
  if v_def not like '%staff_loan_repayment%' then
    raise exception 'FAIL B: dedicated ledger category missing';
  end if;
  if v_def not like '%due_on <= current_date%' then
    raise exception 'FAIL C: recovery has no due-date test';
  end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='sweep_staff_loan_recovery';
  if v_def like '%staff_loan_accrue_interest%' then
    raise exception 'FAIL D: sweep still calls accrual';
  end if;

  select count(*), max(schedule) into v_jobs, v_sched
    from cron.job where jobname = 'staff-loan-recovery-daily';
  if v_jobs <> 1 then raise exception 'FAIL E: % cron jobs named staff-loan-recovery-daily', v_jobs; end if;
  if v_sched <> '0 4 * * *' then raise exception 'FAIL F: unexpected schedule %', v_sched; end if;

  raise notice 'LOAN-RECOVERY-2026-09-21-G PASSED — recovery bounded to amounts due, scheduled daily at 04:00 UTC';
end $$;

-- =====================================================================
-- END LOAN-RECOVERY-2026-09-21-G
-- =====================================================================