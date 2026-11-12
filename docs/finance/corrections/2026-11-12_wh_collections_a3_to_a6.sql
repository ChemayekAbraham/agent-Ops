-- WELILE HOMES RENT COLLECTIONS BOOKED TO RENT PLANS (A3) INSTEAD OF A6 — batch acct_corr_202611_wh_a3_a6.
-- DRAFT, NOT APPROVED. DO NOT RUN without the CFO's explicit approval.
--
-- ACCOUNTING RECORDS ONLY. Platform-scope reclassification: no wallet leg; no wallet, collection, payout, dues or
-- subscription change; nothing is deleted. Each original entry stays as it is; this adds an offsetting pair.
--
-- Evidence (read-only, 12 Nov 2026): welile_home_record_collection posted Welile Homes rent as platform
-- 'rent_repayment' (resolves to A3, tenant Rent Plan receivables) until migration 20260903100200 (3 Sep 2026,
-- "Welile Homes collections now reduce the A6 receivable"); from then on it posts 'landlord_receivable_collected'
-- (A6). The 10 August entries below were never restated: they reduced A3 for tenants who have no Rent Plan and left
-- the Welile Homes receivable (A6) overstated. The cash side of each (agent float, A2) is correct and untouched.
-- Policy (CFO, 12 Nov 2026): A6/L4 hold 12 months of future rent; collections reduce A6.
--
-- Per original entry, one balanced group, dated to the original entry:
--   DR A3 rent_repayment                (cash_out)  - restores the tenant Rent Plan receivable wrongly reduced
--   CR A6 landlord_receivable_collected (cash_in)   - reduces the Welile Homes receivable as the collection should have
-- landlord_receivable_collected is a Money In category, so each group is excluded from Money In (it is not new money).
-- 10 entries, UGX 1,075,000. Effect: A3 +1,075,000; A6 -1,075,000; total assets, cash, wallets unchanged.
-- Runs at REPEATABLE READ. Rollback: the same groups with directions swapped (see the end of this file).
begin isolation level repeatable read;

create temp table _s (leg uuid primary key, amount numeric not null) on commit drop;
insert into _s values
  ('26ecb39b-3f14-46da-bf01-36219dd0eaeb',  60000),  -- 2026-08-03 Ndaula Thomas        sub 4b7a881f
  ('2cf70ce5-9bc0-4077-aba8-f3a08b597a8b', 150000),  -- 2026-08-06 MR. NDAULA THOMAS    sub 60261209
  ('375ddd98-7672-426e-8081-6b38476cacff', 150000),  -- 2026-08-06 MR. NDAULA THOMAS    sub 60261209
  ('8bdaa331-5635-4320-8b0e-c3c9deec81b2', 160000),  -- 2026-08-06 MR. NDAULA THOMAS    sub 08a4fdcc
  ('c10e7a28-39a6-4294-8111-5fc3d7b8eae4',  40000),  -- 2026-08-06 MR. NDAULA THOMAS    sub 82b3d6c5
  ('c4d88237-ca58-4edd-8101-9423cf5a05af', 150000),  -- 2026-08-07 Ms Babirye Patricia  sub abfaa6d4
  ('6457be26-b536-43ed-ad3c-76e32e631f76',   5000),  -- 2026-08-07 (deleted sub)        sub e132bd2b
  ('37d32a15-edef-4946-9855-1fc1f2b203f7', 110000),  -- 2026-08-11 MR. NDAULA THOMAS    sub 9bdfc58c
  ('2fc105ea-2708-4fac-b876-dac6949d7dd9', 150000),  -- 2026-08-24 MR. NDAULA THOMAS    sub 60261209
  ('59df060b-95f1-4737-aa76-b470b8f4b359', 100000);  -- 2026-08-24 Ndaula Thomas        sub 4b7a881f
create temp table _expected (n int not null, amount numeric not null) on commit drop;
insert into _expected values (10, 1075000);

do $corr$
declare
  c_batch constant text := 'acct_corr_202611_wh_a3_a6';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  e record; r record; v_n int; v_x numeric; v_grp uuid;
  s_wallet_legs bigint; s_wallet_sum numeric;
begin
  if exists (select 1 from public.accounting_correction_register where batch = c_batch) then
    raise exception 'STOP: batch % is already posted', c_batch;
  end if;
  select * into e from _expected;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from _s;
  if v_n <> e.n or v_x <> e.amount then raise exception 'STOP: input is % / %, approved % / %', v_n, v_x, e.n, e.amount; end if;

  -- 1. Every entry must still be what the evidence describes.
  for r in select s.*, g.id is not null found, g.ledger_scope, g.category, g.direction, g.amount gl_amount, g.source_table,
                  g.description
             from _s s left join public.general_ledger g on g.id = s.leg
  loop
    if not r.found or r.ledger_scope <> 'platform' or r.category <> 'rent_repayment' or r.direction <> 'cash_in'
       or r.gl_amount <> r.amount or r.source_table <> 'welile_homes_subscriptions'
       or r.description not like 'Welile Homes rent received%' then
      raise exception 'STOP: entry % no longer matches the evidence', r.leg;
    end if;
  end loop;

  -- 2. Money-safety snapshot.
  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';

  -- 3. One balanced platform-only group per entry, dated to the original entry.
  for r in select s.leg, s.amount, g.transaction_group_id orig_group, g.transaction_date, g.source_id
             from _s s join public.general_ledger g on g.id = s.leg order by g.transaction_date, s.leg
  loop
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'rent_repayment',
        'source_table', 'general_ledger', 'source_id', r.leg::text, 'reference_id', r.orig_group::text, 'currency', 'UGX',
        'transaction_date', r.transaction_date, 'classification', 'production',
        'description', format('Correction (accounting only, no money moved): Welile Homes rent of UGX %s collected for subscription %s was booked against tenant Rent Plans (A3); restores A3.', r.amount, r.source_id)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount, 'category', 'landlord_receivable_collected',
        'source_table', 'general_ledger', 'source_id', r.leg::text, 'reference_id', r.orig_group::text, 'currency', 'UGX',
        'transaction_date', r.transaction_date, 'classification', 'production',
        'description', format('Correction (accounting only, no money moved): the same UGX %s reduces the Welile Homes receivable (A6) for subscription %s, as collections do since 3 Sep 2026.', r.amount, r.source_id))),
      idempotency_key := c_batch || ':' || r.leg::text);
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
    values (v_grp, 'Reclassification of Welile Homes rent already received (accounting only): not new money', 'WH1');
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, original_group_id,
      original_leg_ids, correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, 'WH1', 'wh_collection_a3_to_a6', 'general_ledger', r.leg, r.orig_group, array[r.leg], v_grp,
      r.amount, r.amount, 0, jsonb_build_object('subscription_id', r.source_id, 'basis', 'migration 20260903100200 not applied to August collections'), c_cfo);
  end loop;

  -- 4. Checks.
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch;
  if v_n <> e.n or v_x <> e.amount then raise exception 'STOP: posted % / %', v_n, v_x; end if;
  if (select count(*) from public.general_ledger where ledger_scope = 'wallet') <> s_wallet_legs
     or (select coalesce(sum(amount), 0) from public.general_ledger where ledger_scope = 'wallet') <> s_wallet_sum then
    raise exception 'STOP: wallet legs changed';
  end if;
  raise notice '% posted: % entries, UGX %', c_batch, v_n, v_x;
end
$corr$;

commit;

-- ROLLBACK (only on CFO instruction): for every group of batch acct_corr_202611_wh_a3_a6 in
-- accounting_correction_register, post the same two legs with directions swapped (idempotency key
-- acct_corr_202611_wh_a3_a6_rb:<group>), add the rollback group to money_in_report_exclusions, and set
-- rolled_back_at / rollback_group_id on the register row. Nothing is deleted.
