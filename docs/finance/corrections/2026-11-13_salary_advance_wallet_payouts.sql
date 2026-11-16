-- SALARY ADVANCES RECORDED AS DISBURSED BUT NEVER PAID — pay to the staff wallets (CFO approved 13 Nov 2026, "option 1").
--
-- Facts (read-only, 13 Nov 2026): two hr_pay_advances of UGX 200,000 were HR- and CEO-approved on 12 Nov and marked
-- "disbursed" on 13 Nov by the release-authority holder through "Record Disbursement", which records an outside payment
-- and moves no money. Neither staff member was paid (no wallet credit, no ledger entry). Payroll will recover them
-- (Awany 200,000 from 1 Dec; Meddy 100,000/month from 10 Dec), so they are paid now to their Welile wallets.
--
-- Per advance, one balanced group (same treatment as a staff-loan payout, staff_loan_disburse):
--   wallet   staff_loan_disbursement cash_in, withdrawable  -> CR L1 (the staff member's wallet rises)
--   platform staff_loan_disbursement cash_out              -> DR A27 (Loans and Advances to Employees)
-- Linked to the advance (source hr_pay_advances / id); idempotency key salary_advance:wallet_payout:<advance id>;
-- the wallet leg carries its own reference SALADV-<id prefix>. The advance rows themselves are not changed.
-- Rollback (only on CFO instruction): the same legs with directions swapped, only while the money is still in the wallet.
begin isolation level repeatable read;

create temp table _pay (advance_id uuid primary key, user_id uuid not null, name text not null, amount numeric not null) on commit drop;
insert into _pay values
  ('5708dbe0-60c7-4e93-90b8-0ecb20b24a82', '4d4c693b-2db0-4aaf-b209-69de4bfe5087', 'MEDDY MUKUNGU', 200000),
  ('7da47e7f-3de6-49fe-8fd6-6aea5ebcdb03', 'b027162e-2d29-4eb2-bd85-2acb734681b3', 'Awany Joseph Bill', 200000);

do $pay$
declare
  r record; v_grp uuid; s_legs bigint; s_sum numeric; v_n int; v_sum numeric;
begin
  -- 1. each advance is still what the evidence shows, and has never been paid or recovered
  for r in select p.*, a.id found, a.principal, a.status, a.disbursed_at, s.user_id staff_user
             from _pay p left join public.hr_pay_advances a on a.id = p.advance_id left join public.hr_staff s on s.id = a.staff_id
  loop
    if r.found is null or r.principal <> r.amount or r.status <> 'approved' or r.disbursed_at is null or r.staff_user <> r.user_id then
      raise exception 'STOP: advance % for % no longer matches the evidence', r.advance_id, r.name;
    end if;
    if exists (select 1 from public.general_ledger g where g.source_table = 'hr_pay_advances' and g.source_id = r.advance_id) then
      raise exception 'STOP: advance % for % already has ledger entries', r.advance_id, r.name;
    end if;
    if exists (select 1 from public.hr_pay_advance_recoveries x where x.advance_id = r.advance_id) then
      raise exception 'STOP: advance % for % already has recoveries', r.advance_id, r.name;
    end if;
  end loop;

  -- 2. money-safety snapshot
  select count(*), coalesce(sum(amount), 0) into s_legs, s_sum from public.general_ledger where ledger_scope = 'wallet';

  -- 3. pay
  for r in select * from _pay order by name loop
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_in', 'amount', r.amount, 'category', 'staff_loan_disbursement',
        'user_id', r.user_id, 'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
        'source_table', 'hr_pay_advances', 'source_id', r.advance_id,
        'reference_id', 'SALADV-' || upper(left(replace(r.advance_id::text, '-', ''), 10)), 'currency', 'UGX',
        'description', format('Salary advance of UGX %s paid to your wallet (approved 12 Nov 2026; recovered from payroll)', r.amount)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'staff_loan_disbursement',
        'recipient_type', 'user', 'source_table', 'hr_pay_advances', 'source_id', r.advance_id,
        'reference_id', 'SALADV-' || upper(left(replace(r.advance_id::text, '-', ''), 10)), 'currency', 'UGX',
        'description', format('Salary advance to %s (UGX %s) paid to the staff wallet; receivable from the employee (A27)', r.name, r.amount))),
      'salary_advance:wallet_payout:' || r.advance_id::text, false);
    raise notice 'paid % UGX % group %', r.name, r.amount, v_grp;
  end loop;

  -- 4. checks: exactly two wallet credits of 200,000, nothing else moved
  select count(*) - s_legs, coalesce(sum(amount), 0) - s_sum into v_n, v_sum from public.general_ledger where ledger_scope = 'wallet';
  if v_n <> 2 or v_sum <> 400000 then
    raise exception 'STOP: wallet legs changed by % / %, expected 2 / 400000', v_n, v_sum;
  end if;
  if (select count(*) from public.general_ledger where source_table = 'hr_pay_advances' and source_id in (select advance_id from _pay)) <> 4 then
    raise exception 'STOP: expected 4 legs for the two advances';
  end if;
end
$pay$;

select json_agg(json_build_object('name', p.full_name, 'withdrawable', w.withdrawable)) as wallets_after
  from public.wallet_balances_projection w join public.profiles p on p.id = w.user_id
 where w.user_id in ('4d4c693b-2db0-4aaf-b209-69de4bfe5087', 'b027162e-2d29-4eb2-bd85-2acb734681b3');

commit;
