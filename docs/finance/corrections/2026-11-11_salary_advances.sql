-- SALARY ADVANCES TO EMPLOYEES — batch salary_adv_202611. DRAFT, not approved.
--
-- ACCOUNTING RECORDS ONLY. Platform-scope journals only: no wallet leg; no wallet, salary, payslip or balance change;
-- nothing is deleted. Requires migration 20261115110000_salary_advances_staff_receivable (categories + mappings).
--
-- Facts (CFO, 11 Nov 2026): the four interest-free "settling-in" advances in hr_pay_advances were paid in cash, outside
-- the app, by Benjamin Muhanguzi with COMPANY money. They are recovered from monthly salaries; the recoveries in
-- hr_pay_advance_recoveries are correct. Evidence (read-only, 11 Nov 2026): no ledger leg exists for any advance or
-- recovery; payslips show gross salary, the recovery as a deduction and only the take-home pay posted (salary_payout).
--
--   advance                                 staff                       principal   recovered   outstanding
--   23f67875-5afb-4029-8193-8dd64413b32b    bwayo mark                  2,500,000   1,875,000     625,000
--   0d724014-e940-4464-b6f8-4be6de9bdced    SARAH ANGWEN                2,000,000   2,000,000           0
--   6b922d39-badc-409a-a5b9-d76b0bc9da61    Timothy Kalyango            1,000,000     666,800     333,200
--   6f793e50-66ca-481e-9bcd-e89ed69d5bfb    TIMOTHY CHRISTIAN WANIAYE   1,500,000   1,125,000     375,000
--                                                                       7,000,000   5,666,800   1,333,200
--
-- Groups (each balanced on raw direction and on the account map):
--   SA1 payout, one per advance, dated 27 Aug 2026 08:00 Kampala (before the August payroll that first recovered it):
--       DR A27 salary_advance_disbursed (cash_in)   / CR A1 salary_advance_cash_paid (cash_out)
--   SA2 recovery, one per hr_pay_advance_recoveries row, dated when that month's salary was posted to the employee:
--       DR X1 salary_advance_recovery_expense (cash_out) / CR A27 salary_advance_recovered (cash_in)
-- Effect: A27 +1,333,200 (Loans and Advances to Employees); A1 -7,000,000; salary expense (X1) +5,666,800.
-- Neither category counts as Money In. Runs at REPEATABLE READ. Rollback: the same groups with directions swapped
-- (end of this file).
begin isolation level repeatable read;

create temp table _adv (advance_id uuid primary key, principal numeric not null) on commit drop;
insert into _adv values
  ('23f67875-5afb-4029-8193-8dd64413b32b', 2500000),  -- bwayo mark
  ('0d724014-e940-4464-b6f8-4be6de9bdced', 2000000),  -- SARAH ANGWEN
  ('6b922d39-badc-409a-a5b9-d76b0bc9da61', 1000000),  -- Timothy Kalyango
  ('6f793e50-66ca-481e-9bcd-e89ed69d5bfb', 1500000);  -- TIMOTHY CHRISTIAN WANIAYE
create temp table _expected (advances int, principal numeric, recoveries int, recovered numeric) on commit drop;
insert into _expected values (4, 7000000, 11, 5666800);
create temp table _params (key text primary key, value text not null) on commit drop;
insert into _params values ('payout_date', '2026-08-27 08:00:00+03');

do $corr$
declare
  c_batch constant text := 'salary_adv_202611';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  e record; r record; v_n int; v_x numeric; v_grp uuid; v_td timestamptz;
  s_wallet_legs bigint; s_wallet_sum numeric; a27_before numeric; a27_after numeric;
begin
  if exists (select 1 from public.accounting_correction_register where batch = c_batch) then
    raise exception 'STOP: batch % is already posted', c_batch;
  end if;
  select * into e from _expected;

  -- 1. Advances must still be what the evidence describes: disbursed, not cancelled, same principal, never booked.
  select count(*), coalesce(sum(a.principal), 0) into v_n, v_x
    from _adv x join public.hr_pay_advances a on a.id = x.advance_id
   where a.principal = x.principal and a.status::text = 'approved' and a.disbursed_at is not null;
  if v_n <> e.advances or v_x <> e.principal then
    raise exception 'STOP: advances are % / %, approved % / %', v_n, v_x, e.advances, e.principal;
  end if;
  -- Recoveries: only payroll runs that were approved, paid or locked (the dashboard's rule).
  select count(*), coalesce(sum(rc.amount), 0) into v_n, v_x
    from public.hr_pay_advance_recoveries rc join public.hr_pay_runs pr on pr.id = rc.run_id
   where rc.advance_id in (select advance_id from _adv) and pr.status::text in ('approved','paid','locked');
  if v_n <> e.recoveries or v_x <> e.recovered then
    raise exception 'STOP: recoveries are % / %, approved % / %', v_n, v_x, e.recoveries, e.recovered;
  end if;
  if exists (select 1 from public.general_ledger g where g.category in
       ('salary_advance_disbursed','salary_advance_cash_paid','salary_advance_recovered','salary_advance_recovery_expense')) then
    raise exception 'STOP: salary advance legs already exist';
  end if;
  if (select count(*) from public.ledger_account_map where ledger_scope = 'platform' and wallet_bucket is null and category in
       ('salary_advance_disbursed','salary_advance_cash_paid','salary_advance_recovered','salary_advance_recovery_expense')) <> 4 then
    raise exception 'STOP: migration 20261115110000 is not applied';
  end if;

  -- 2. Money-safety snapshot (wallet legs must not change) and A27 before, on the base mapping.
  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';
  select coalesce(sum(case when g.direction = m.debit_when then g.amount else -g.amount end), 0) into a27_before
    from public.general_ledger g join public.ledger_account_map m
      on m.ledger_scope = g.ledger_scope and m.category = g.category and m.wallet_bucket is null
   where m.account_code = 'A27' and g.ledger_scope = 'platform';

  -- 3a. SA1 payouts.
  v_td := (select value from _params where key = 'payout_date')::timestamptz;
  for r in select x.advance_id, a.principal, s.user_id, p.full_name
             from _adv x join public.hr_pay_advances a on a.id = x.advance_id
             join public.hr_staff s on s.id = a.staff_id left join public.profiles p on p.id = s.user_id
            order by p.full_name
  loop
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.principal, 'category', 'salary_advance_disbursed',
        'user_id', r.user_id, 'source_table', 'hr_pay_advances', 'source_id', r.advance_id::text, 'currency', 'UGX',
        'transaction_date', v_td, 'classification', 'production',
        'description', format('Salary advance (settling-in, interest-free) to %s: UGX %s paid in cash outside the app by Benjamin Muhanguzi with company money; owed by the employee and recovered from salary.', r.full_name, r.principal)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.principal, 'category', 'salary_advance_cash_paid',
        'user_id', r.user_id, 'source_table', 'hr_pay_advances', 'source_id', r.advance_id::text, 'currency', 'UGX',
        'transaction_date', v_td, 'classification', 'production',
        'description', format('Company cash paid out as a salary advance to %s (UGX %s), outside the app.', r.full_name, r.principal))),
      idempotency_key := c_batch || ':payout:' || r.advance_id::text);
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, correction_group_id,
      amount, before_value, after_value, detail, created_by)
    values (c_batch, 'SA1', 'salary_advance_payout_recognised', 'hr_pay_advances', r.advance_id, v_grp, r.principal, 0, r.principal,
      jsonb_build_object('employee', r.full_name, 'paid_by', 'Benjamin Muhanguzi (cash, company money, outside the app)',
                         'interest', '0%', 'basis', 'CFO 11 Nov 2026'), c_cfo);
  end loop;

  -- 3b. SA2 recoveries, dated when that month's salary was posted to the employee.
  for r in select rc.id, rc.amount, pe.code period, s.user_id, p.full_name,
                  coalesce((select min(g.transaction_date) from public.general_ledger g
                             where g.user_id = s.user_id and g.ledger_scope = 'wallet' and g.category = 'salary_payout'
                               and g.description = 'Salary for ' || pe.code),
                           ((to_date(pe.code, 'YYYY-MM') + interval '1 month' - interval '1 day')::date + time '17:00') at time zone 'Africa/Kampala') td
             from public.hr_pay_advance_recoveries rc
             join public.hr_pay_runs pr on pr.id = rc.run_id and pr.status::text in ('approved','paid','locked')
             join public.hr_pay_periods pe on pe.id = pr.period_id
             join public.hr_pay_advances a on a.id = rc.advance_id
             join public.hr_staff s on s.id = a.staff_id left join public.profiles p on p.id = s.user_id
            where rc.advance_id in (select advance_id from _adv)
            order by pe.code, p.full_name
  loop
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'salary_advance_recovery_expense',
        'user_id', r.user_id, 'source_table', 'hr_pay_advance_recoveries', 'source_id', r.id::text, 'currency', 'UGX',
        'transaction_date', r.td, 'classification', 'production',
        'description', format('Salary %s for %s: UGX %s withheld from pay to recover the settling-in advance is part of salary cost.', r.period, r.full_name, r.amount)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount, 'category', 'salary_advance_recovered',
        'user_id', r.user_id, 'source_table', 'hr_pay_advance_recoveries', 'source_id', r.id::text, 'currency', 'UGX',
        'transaction_date', r.td, 'classification', 'production',
        'description', format('Settling-in advance of %s: UGX %s recovered from the %s salary.', r.full_name, r.amount, r.period))),
      idempotency_key := c_batch || ':recovery:' || r.id::text);
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, correction_group_id,
      amount, before_value, after_value, detail, created_by)
    values (c_batch, 'SA2', 'salary_advance_recovery_recognised', 'hr_pay_advance_recoveries', r.id, v_grp, r.amount, 0, r.amount,
      jsonb_build_object('employee', r.full_name, 'payroll_period', r.period), c_cfo);
  end loop;

  -- 4. Checks.
  select count(*) filter (where correction_item = 'SA1'), coalesce(sum(amount) filter (where correction_item = 'SA1'), 0)
    into v_n, v_x from public.accounting_correction_register where batch = c_batch;
  if v_n <> e.advances or v_x <> e.principal then raise exception 'STOP: posted payouts % / %', v_n, v_x; end if;
  select count(*) filter (where correction_item = 'SA2'), coalesce(sum(amount) filter (where correction_item = 'SA2'), 0)
    into v_n, v_x from public.accounting_correction_register where batch = c_batch;
  if v_n <> e.recoveries or v_x <> e.recovered then raise exception 'STOP: posted recoveries % / %', v_n, v_x; end if;
  if (select count(*) from public.general_ledger where ledger_scope = 'wallet') <> s_wallet_legs
     or (select coalesce(sum(amount), 0) from public.general_ledger where ledger_scope = 'wallet') <> s_wallet_sum then
    raise exception 'STOP: wallet legs changed';
  end if;
  select coalesce(sum(case when g.direction = m.debit_when then g.amount else -g.amount end), 0) into a27_after
    from public.general_ledger g join public.ledger_account_map m
      on m.ledger_scope = g.ledger_scope and m.category = g.category and m.wallet_bucket is null
   where m.account_code = 'A27' and g.ledger_scope = 'platform';
  if a27_after - a27_before <> e.principal - e.recovered then
    raise exception 'STOP: A27 moved by %, expected %', a27_after - a27_before, e.principal - e.recovered;
  end if;
  raise notice 'salary_adv_202611 posted: % payouts UGX %, % recoveries UGX %, A27 +%',
    e.advances, e.principal, e.recoveries, e.recovered, a27_after - a27_before;
end
$corr$;

commit;

-- ROLLBACK (only on CFO instruction): for every group of batch salary_adv_202611 in accounting_correction_register,
-- post the same legs with directions swapped (idempotency key salary_adv_202611_rb:<group>) and set rolled_back_at /
-- rollback_group_id on the register row. Nothing is deleted.
