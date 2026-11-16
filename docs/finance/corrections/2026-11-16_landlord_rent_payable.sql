-- LANDLORD RENT PAYABLE (L4) — batch acct_corr_202611_landlord_l4. DRAFT, not approved.
--
-- ACCOUNTING RECORDS ONLY. NO MONEY MOVEMENT. Platform/bridge journals only: no wallet leg; no payout, Rent Plan,
-- allocation, wallet or portfolio record changes; nothing is deleted. Runs AFTER migration 20261125090000.
--
-- Item 1 (CFO approved 16 Nov 2026). With the migration, Rent Plan funding is rent owed to the landlord (CR L4) and a
-- payout, when sent, settles it (DR L4 / CR A1). This batch records the history:
--   P1. every landlord payout already sent (status awaiting_agent_receipt / disbursed / completed) before the migration:
--       DR L4 landlord_rent_payout_settled (cash_in) / CR A1 landlord_rent_payout_cash (cash_out), dated on the payout's own date — the same
--       entry the new trigger posts for new payouts (same idempotency key, so never twice);
--   P2. 23 Rent Plans whose landlord was paid but whose funding was later reversed in the books ("allocation return",
--       "send-back", "cancellation") while the plan stayed live: the reversal is undone up to the amount paid
--       (DR A3 rent_receivable_created / CR L4 rent_disbursement), dated on the reversal's date.
-- HELD for review (not in this batch): the three July Rent Plans of IAN MUHWEZI paid with no MoMo reference
-- (3a0e473c, 52626ed8, 7a45b15e; 12,000,000), the cancelled plan 372e8806 (tenant deleted; 100,000), and the amounts
-- "returned" above what was paid (37c15509 200,000; 5530b7ce 200,000). They remain visible as L4 balances.
-- Rollback: the same groups with directions swapped (see the end of this file).
begin isolation level repeatable read;

-- P1 expectation is set from the preview (2026-11-16_landlord_rent_payable_preview.sql) at apply time.
create temp table _expected (p1_n int not null, p1_amount numeric not null, p2_n int not null, p2_amount numeric not null) on commit drop;
insert into _expected values (0, 0, 23, 9290000);

-- P2: Rent Plan, amount to undo (= least of returned and paid), paid to the landlord, reversed in the books
create temp table _undo (rent_request_id uuid primary key, amount numeric not null, paid numeric not null, returned numeric not null) on commit drop;
insert into _undo (rent_request_id, amount, paid, returned) values
  ('b6687c70-5782-48c5-8c57-bb7be2cd4383', 600000, 1800000, 600000),
  ('aff29995-7139-4efb-995e-541f179c64dd', 1500000, 1500000, 1500000),
  ('317170e6-ea6e-4599-acfc-b0a430ba77c3', 800000, 800000, 800000),
  ('fcf060a8-087b-4676-88f5-03aba4b5ad1f', 700000, 700000, 700000),
  ('1c2be72b-58d5-4b31-aa17-5ab1224e0198', 300000, 600000, 300000),
  ('3c180549-c0d1-4186-a8e6-c75f0a535412', 600000, 600000, 600000),
  ('d64fb655-7014-48ce-9187-cf7379ffa8db', 600000, 600000, 600000),
  ('3ce32352-ca03-4630-8f99-37eb767d12ea', 500000, 500000, 500000),
  ('1e600143-9a6b-42e2-91f4-8fbb8a658058', 500000, 500000, 500000),
  ('007f64a4-e7ba-4e63-8499-6a563e7eecb7', 500000, 500000, 500000),
  ('a436d6ae-68e3-4369-baf8-0518c288b87b', 400000, 400000, 400000),
  ('8e9b7c3e-7db7-4500-9d11-47ffe89fa84e', 400000, 400000, 400000),
  ('a7fe92c5-af67-446c-8321-faeeeb76174e', 150000, 350000, 150000),
  ('c9acf583-3c82-465d-9e2a-5bda1d4a66ed', 100000, 300000, 100000),
  ('4558dc54-d170-474b-8acd-94cfbe69b17c', 250000, 250000, 250000),
  ('cc699b0b-2763-4f95-84fb-5eab322f39b7', 250000, 250000, 250000),
  ('fe47de6a-5703-462e-8f54-dee8019fb97c', 200000, 200000, 200000),
  ('37c15509-4ed0-4a63-bde2-0d8d9f58b0c1', 200000, 200000, 400000),
  ('aca82e7c-edf1-4ace-937f-d22b50f20b88', 200000, 200000, 200000),
  ('09ed2701-4d05-4303-899f-a32ed8bb00f9', 200000, 200000, 200000),
  ('d3e07f8e-e41f-4253-9c9b-b4cd9664b795', 140000, 140000, 140000),
  ('1c635d8d-7ecf-45a9-bdc0-c64dd946a1a0', 100000, 100000, 100000),
  ('5530b7ce-22ce-4e11-a513-579199600757', 100000, 100000, 300000)
;

do $corr$
declare
  c_batch constant text := 'acct_corr_202611_landlord_l4';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  c_sent  constant text[] := array['awaiting_agent_receipt', 'disbursed', 'completed'];
  r record; e record; v_n int; v_x numeric; v_grp uuid; v_paid numeric; v_ret numeric; v_ref text; v_td timestamptz;
  s_wallet_legs bigint; s_wallet_sum numeric; s_lp text; s_rr text;
begin
  -- 0. The migration is installed; the batch has not run.
  if (select account_code from public.ledger_account_map where ledger_scope = 'platform' and category = 'rent_disbursement' and wallet_bucket is null) is distinct from 'L4'
     or (select count(*) from public.ledger_account_map where category in ('landlord_rent_payout_settled', 'landlord_rent_payout_cash')) <> 2 then
    raise exception 'STOP: migration 20261125090000 is not installed';
  end if;
  if exists (select 1 from public.accounting_correction_register where batch = c_batch) then
    raise exception 'STOP: batch % is already posted', c_batch;
  end if;
  select * into e from _expected;

  -- 1. Inputs still match the evidence.
  select count(*), coalesce(sum(l.amount), 0) into v_n, v_x
    from public.landlord_payouts l
   where l.status = any (c_sent) and l.rent_request_id is not null and coalesce(l.amount, 0) > 0
     and not exists (select 1 from public.general_ledger g where g.source_table = 'landlord_payouts' and g.source_id = l.id
                       and g.category = 'landlord_rent_payout_settled');
  if v_n <> e.p1_n or v_x <> e.p1_amount then
    raise exception 'STOP: P1 payouts are % / %, approved % / % (re-run the preview)', v_n, v_x, e.p1_n, e.p1_amount;
  end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from _undo;
  if v_n <> e.p2_n or v_x <> e.p2_amount then raise exception 'STOP: P2 input is % / %, approved % / %', v_n, v_x, e.p2_n, e.p2_amount; end if;
  for r in select * from _undo loop
    select coalesce(sum(amount), 0) into v_paid from public.landlord_payouts where rent_request_id = r.rent_request_id and status = any (c_sent);
    select coalesce(sum(amount), 0) into v_ret from public.general_ledger
     where category = 'rent_disbursement' and ledger_scope = 'platform' and direction = 'cash_in' and source_table = 'rent_requests'
       and source_id = r.rent_request_id and classification in ('production', 'legacy_real');
    if v_paid <> r.paid or v_ret <> r.returned or r.amount <> least(r.paid, r.returned) then
      raise exception 'STOP: Rent Plan % no longer matches the evidence (paid % vs %, reversed % vs %)', r.rent_request_id, v_paid, r.paid, v_ret, r.returned;
    end if;
    if exists (select 1 from public.general_ledger g where g.idempotency_key = c_batch || ':undo:' || r.rent_request_id::text) then
      raise exception 'STOP: Rent Plan % already corrected', r.rent_request_id;
    end if;
  end loop;

  -- 2. Money-safety snapshot.
  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_lp from public.landlord_payouts t;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_rr from public.rent_requests t where t.id in (select rent_request_id from _undo);

  -- 3a. P1: one group per payout already sent, on the payout's own date.
  for r in select l.* from public.landlord_payouts l
            where l.status = any (c_sent) and l.rent_request_id is not null and coalesce(l.amount, 0) > 0
              and not exists (select 1 from public.general_ledger g where g.source_table = 'landlord_payouts' and g.source_id = l.id
                                and g.category = 'landlord_rent_payout_settled')
            order by coalesce(l.finops_disbursed_at, l.disbursed_at, l.created_at), l.id
  loop
    v_ref := coalesce(nullif(r.finops_momo_reference, ''), nullif(r.external_reference, ''), r.id::text);
    v_td  := coalesce(r.finops_disbursed_at, r.disbursed_at, r.created_at);
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount, 'category', 'landlord_rent_payout_settled',
        'source_table', 'landlord_payouts', 'source_id', r.id, 'reference_id', v_ref, 'currency', 'UGX', 'classification', 'production',
        'transaction_date', v_td,
        'description', format('Correction (accounting only, no money moved): landlord rent payout to %s (UGX %s, ref %s) recorded on its own date; settles the rent owed for Rent Plan %s',
                              coalesce(r.landlord_name, 'landlord'), r.amount, v_ref, left(r.rent_request_id::text, 8))),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'landlord_rent_payout_cash',
        'source_table', 'landlord_payouts', 'source_id', r.id, 'reference_id', v_ref, 'currency', 'UGX', 'classification', 'production',
        'transaction_date', v_td,
        'description', format('Correction (accounting only, no money moved): cash paid to the landlord on %s (ref %s)', v_td::date, v_ref))),
      'landlord_rent_payout:' || r.id::text || ':1', false);
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, rent_request_id,
      correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, 'P1', 'landlord_payout_recorded_when_sent', 'landlord_payouts', r.id, r.rent_request_id, v_grp, r.amount, 0, r.amount,
      jsonb_build_object('status', r.status, 'paid_on', v_td, 'reference', v_ref), c_cfo);
  end loop;

  -- 3b. P2: undo the reversal, up to the amount paid, on the reversal's date (tagged to the reversal leg it corrects).
  for r in select u.*, x.id leg_id, x.transaction_group_id leg_group, x.transaction_date leg_date
           from _undo u
           join lateral (select g.id, g.transaction_group_id, g.transaction_date from public.general_ledger g
                          where g.category = 'rent_disbursement' and g.ledger_scope = 'platform' and g.direction = 'cash_in'
                            and g.source_table = 'rent_requests' and g.source_id = u.rent_request_id
                            and g.classification in ('production', 'legacy_real')
                          order by g.transaction_date desc, g.id desc limit 1) x on true
           order by x.transaction_date, u.rent_request_id
  loop
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'bridge', 'direction', 'cash_in', 'amount', r.amount, 'category', 'rent_receivable_created',
        'source_table', 'general_ledger', 'source_id', r.leg_id, 'reference_id', r.rent_request_id::text, 'currency', 'UGX',
        'classification', 'production', 'transaction_date', r.leg_date,
        'description', format('Correction (accounting only, no money moved): the landlord was paid (UGX %s) and Rent Plan %s stayed live, so the reversal of its funding is undone (UGX %s); restores the tenant''s Rent Plan receivable',
                              r.paid, left(r.rent_request_id::text, 8), r.amount)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'rent_disbursement',
        'source_table', 'general_ledger', 'source_id', r.leg_id, 'reference_id', r.rent_request_id::text, 'currency', 'UGX',
        'classification', 'production', 'transaction_date', r.leg_date,
        'description', format('Correction (accounting only, no money moved): rent owed to the landlord for Rent Plan %s restored (UGX %s); settled by the payout already recorded',
                              left(r.rent_request_id::text, 8), r.amount))),
      c_batch || ':undo:' || r.rent_request_id::text, false);
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, rent_request_id,
      original_group_id, original_leg_ids, correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, 'P2', 'funding_reversal_undone_landlord_paid', 'general_ledger', r.leg_id, r.rent_request_id, r.leg_group, array[r.leg_id],
      v_grp, r.amount, r.returned, r.returned - r.amount, jsonb_build_object('paid', r.paid, 'returned', r.returned), c_cfo);
  end loop;

  -- 4. Checks.
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch and correction_item = 'P1';
  if v_n <> e.p1_n or v_x <> e.p1_amount then raise exception 'STOP: P1 posted % / %', v_n, v_x; end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch and correction_item = 'P2';
  if v_n <> e.p2_n or v_x <> e.p2_amount then raise exception 'STOP: P2 posted % / %', v_n, v_x; end if;
  if exists (select 1 from public.general_ledger g join public.accounting_correction_register a on a.correction_group_id = g.transaction_group_id
              where a.batch = c_batch and g.ledger_scope = 'wallet') then
    raise exception 'STOP: a correction leg is wallet-scope';
  end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.general_ledger where ledger_scope = 'wallet';
  if v_n <> s_wallet_legs or v_x <> s_wallet_sum then raise exception 'STOP: a wallet-scope ledger leg was written'; end if;
  if (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.landlord_payouts t) <> s_lp then
    raise exception 'STOP: a landlord payout record changed';
  end if;
  if (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.rent_requests t where t.id in (select rent_request_id from _undo)) <> s_rr then
    raise exception 'STOP: a Rent Plan record changed';
  end if;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
  values (c_cfo, 'accounting_correction_batch_posted', 'landlord_rent_payable', 'accounting_correction_register', c_batch,
    'Landlord rent payable (L4): payouts recorded when sent; funding reversals undone where the landlord was paid (accounting only)',
    jsonb_build_object('p1_payouts', e.p1_n, 'p1_amount', e.p1_amount, 'p2_plans', e.p2_n, 'p2_amount', e.p2_amount));
  raise notice 'batch % posted: P1 % payouts UGX %, P2 % plans UGX %', c_batch, e.p1_n, e.p1_amount, e.p2_n, e.p2_amount;
end $corr$;

commit;

-- ROLLBACK (only on CFO instruction): for each register row of this batch, post the same legs with directions swapped,
-- idempotency key acct_corr_202611_landlord_l4:rb:<register id>, dated today, and set rolled_back_at.
