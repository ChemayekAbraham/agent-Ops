-- INBOUND PAYMENTS ROUTED BY CFO DIRECT CREDIT TO NON-AGENTS' FLOAT — batch acct_corr_202611_cfo_routed. DRAFT, not approved.
--
-- ACCOUNTING RECORDS ONLY. NO MONEY MOVEMENT. Platform-scope journals only: no wallet leg; no wallet, credit, portfolio,
-- Returns or payout change; nothing is deleted.
--
-- Evidence (read-only, 10 Nov 2026): each listed credit is a CFO Direct Credit "Operational Float (from email)" that routed
-- an INCOMING mobile-money receipt (email_credit_idempotency -> gmail_transactions direction 'in', same amount) into the
-- float of a payer with no agent role. It was booked DR A2 agent float / CR A8 float cycle control and never reached
-- A1. The float-origin trace shows the full amount then paid for the SAME person's portfolio (DR L1 / CR L2).
-- Same treatment as batch acct_corr_202611_momo_supporter (posted 10 Nov) and the permanent fix in cfo-direct-credit.
--
-- Per credit, one balanced group:
--   DR A1 verified_bank_cash_recognised (cash_in)  - money received on the company's mobile-money line
--   DR A8 agent_float_deposit           (cash_in)  - reverses the float-cycle credit
--   CR L1 cash_custody_payable          (cash_out) - held for the payer; closed by the existing portfolio leg
--   CR A2 agent_float_cash_offset       (cash_out) - reverses the agent-float debit
--
-- 13 credits, UGX 14,720,000. Not included: 2 receipt-routed credits whose float was not used for the payer's own
-- portfolio (1,100,000), 1 to a deleted account (4,000,000), 6 credits without an inbound receipt (manual allocations).
-- Runs at REPEATABLE READ so the money-safety checks compare one snapshot plus this batch's own writes.
-- Legs are tagged source_table 'general_ledger' / source_id = the corrected credit's wallet leg: this is a platform-only
-- accounting correction evidenced in accounting_correction_register, not a CFO wallet-tool entry (the first run, tagged
-- 'cfo_direct_credit', was refused by enforce_wallet_correction_evidence; nothing was posted).
-- Rollback: the same groups with directions swapped (see the end of this file).
begin isolation level repeatable read;

create temp table _s (wallet_leg uuid primary key, orig_group uuid not null, amount numeric not null) on commit drop;
insert into _s (wallet_leg, orig_group, amount) values
  ('c5c1ace9-0648-49d5-a825-69ef95fdcd00', '7f476485-9be6-4b89-b5bf-25e9754c146c', 1000000),  -- 2026-09-14 PAY-MU1BICKX-SVO7 Ayesiga Kenneth
  ('f85e8298-ec36-42fc-a751-fa4009ffa3aa', 'af98a061-d7c0-46f5-bea2-427251928570', 100000),  -- 2026-09-16 PAY-MU3ZNKHE-Y2WF Winnie Munabi
  ('43ac81b2-453f-4234-a637-43693569ce5a', '1aa1acff-abc6-4d1d-97fa-93756848930e', 1200000),  -- 2026-09-21 PAY-MUAZJF3Q-N7U7 Tatianne Mirembe
  ('063a738e-8846-46ca-9bf3-e85a5731290d', '6ffe5d06-a4ad-4280-ae16-0197fad69b90', 1000000),  -- 2026-09-24 PAY-MUFHMRI0-KN8O Ayesiga Kenneth
  ('e1e01a7d-4f2b-4526-abd9-b255eceb8606', 'ac5901b0-77c2-4c07-bc68-152c3cbd8b52', 2000000),  -- 2026-09-28 PAY-MUL5104Z-Q5NP Doreen Muhawe
  ('854a9bb4-5c03-4514-984a-b612e1022116', '7ec08e0f-4860-450e-aa8c-be5e59a1a2e3', 100000),  -- 2026-09-30 PAY-MUNXFS5B-4I0F Tumwebaze Henry
  ('bb2875ec-c353-42fe-bd90-e130e0c6499c', '59574ac2-f37c-45de-aac6-124e25950531', 1000000),  -- 2026-10-07 PAY-MUXSF82U-02UJ Adrine Atuhaire
  ('9829c4e0-c301-48da-a5a2-8e04963557c7', 'cf865665-4716-45a1-ad15-50aff04df7b9', 1000000),  -- 2026-10-08 PAY-MUZAOELR-CW3T CABRINE IMELDA NAKINTU
  ('061a48a2-782f-4dd3-b5f7-3d500f63608b', 'e9e80382-97e4-4479-a022-4bfcc9ce2d8e', 2000000),  -- 2026-10-12 PAY-MV50AIYY-8FHK Ceasor Ojera
  ('b941754a-1152-40ca-93ad-3f6235d05e68', 'd201c3d5-67c8-4484-b589-485339c6a08b', 100000),  -- 2026-10-16 PAY-MVAQDTG6-C0BR Winnie Munabi
  ('5303943c-b940-4a8e-aef6-23efdf4f58e1', 'c6eb5b53-7f41-4f98-8cad-fabf771958b8', 4000000),  -- 2026-10-26 PAY-MVPAB7Z6-39DL Alice Chebet Alice Chebet
  ('b50a4629-4bad-4128-810b-22cad4717ac5', '0a811d4f-c425-4c0e-9b45-bf0185231cd5', 220000),  -- 2026-10-29 PAY-MVTAZLIP-KBRG Kobusinge Violet
  ('25a25885-ee2b-47b3-b1be-73182f93961e', 'c0bbd734-08e8-41c1-9c47-b21528c3c629', 1000000)  -- 2026-11-10 PAY-MWAHPU9H-HZSQ Chelimo sharon
;
create temp table _expected (n int not null, amount numeric not null) on commit drop;
insert into _expected values (13, 14720000);
create temp table _params (key text primary key, value text not null) on commit drop;
insert into _params values ('transaction_date', 'original');

do $corr$
declare
  c_batch constant text := 'acct_corr_202611_cfo_routed';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  r record; e record; v_n int; v_x numeric; v_grp uuid; v_td timestamptz; v_mode text;
  s_wallet_legs bigint; s_wallet_sum numeric; s_pf text;
begin
  if exists (select 1 from public.accounting_correction_register where batch = c_batch) then
    raise exception 'STOP: batch % is already posted', c_batch;
  end if;
  select * into e from _expected;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from _s;
  if v_n <> e.n or v_x <> e.amount then raise exception 'STOP: input is % / %, approved % / %', v_n, v_x, e.n, e.amount; end if;
  v_mode := (select value from _params where key = 'transaction_date');

  -- 1. Every credit must still be what the evidence describes.
  for r in
    select s.*, w.user_id, w.amount credit_amount, w.reference_id ref, w.transaction_date orig_date,
           (w.transaction_group_id = s.orig_group and w.source_table = 'cfo_direct_credit' and w.ledger_scope = 'wallet'
              and w.wallet_bucket = 'float' and w.direction = 'cash_in') wallet_ok,
           (select count(*) from public.general_ledger p where p.transaction_group_id = s.orig_group and p.ledger_scope = 'platform'
              and p.category = 'agent_float_deposit' and p.direction = 'cash_out' and p.amount = w.amount) platform_ok,
           exists (select 1 from public.email_credit_idempotency ec join public.gmail_transactions gt on gt.id = ec.gmail_transaction_id
                    where ec.reference_id = w.reference_id and ec.operation = 'credit' and gt.direction = 'in'
                      and abs(gt.amount - w.amount) <= 1) receipt_ok,
           exists (select 1 from public.user_roles ur where ur.user_id = w.user_id and ur.role = 'agent') is_agent
    from _s s left join public.general_ledger w on w.id = s.wallet_leg
  loop
    if not coalesce(r.wallet_ok, false) or r.platform_ok <> 1 or not r.receipt_ok or r.is_agent
       or r.amount <= 0 or r.amount > r.credit_amount then
      raise exception 'STOP: credit % no longer matches the evidence (wallet %, platform %, receipt %, agent %, amount % of %)',
        r.wallet_leg, r.wallet_ok, r.platform_ok, r.receipt_ok, r.is_agent, r.amount, r.credit_amount;
    end if;
  end loop;

  -- 2. Money-safety snapshot.
  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_pf from public.investor_portfolios t;

  -- 3. One balanced platform group per credit.
  for r in select s.*, w.reference_id ref, w.transaction_date orig_date, w.user_id
           from _s s join public.general_ledger w on w.id = s.wallet_leg order by w.transaction_date, s.wallet_leg
  loop
    v_td := case when v_mode = 'original' then r.orig_date else v_mode::timestamptz end;
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount, 'category', 'verified_bank_cash_recognised',
        'source_table', 'general_ledger', 'source_id', r.wallet_leg::text, 'reference_id', r.orig_group::text, 'currency', 'UGX',
        'transaction_date', v_td, 'classification', 'production',
        'description', format('Correction (accounting only, no money moved): inbound payment routed by CFO Direct Credit %s (UGX %s, used for the payer''s own portfolio) was received on the company''s mobile-money line; records it as cash.', r.ref, r.amount)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount, 'category', 'agent_float_deposit',
        'source_table', 'general_ledger', 'source_id', r.wallet_leg::text, 'reference_id', r.orig_group::text, 'currency', 'UGX',
        'transaction_date', v_td, 'classification', 'production',
        'description', format('Correction (accounting only, no money moved): reverses the float-cycle credit booked for routed payment %s, which was the payer''s own money, not agent float.', r.ref)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'cash_custody_payable',
        'source_table', 'general_ledger', 'source_id', r.wallet_leg::text, 'reference_id', r.orig_group::text, 'currency', 'UGX',
        'transaction_date', v_td, 'classification', 'production',
        'description', format('Correction (accounting only, no money moved): payer''s money held for them until it funded their portfolio (closed by the existing portfolio payment). Credit %s.', r.ref)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'agent_float_cash_offset',
        'source_table', 'general_ledger', 'source_id', r.wallet_leg::text, 'reference_id', r.orig_group::text, 'currency', 'UGX',
        'transaction_date', v_td, 'classification', 'production',
        'description', format('Correction (accounting only, no money moved): reverses the agent-float debit for routed payment %s; the money was received by the company, not held by an agent.', r.ref))),
      idempotency_key := c_batch || ':' || r.wallet_leg::text);
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
    values (v_grp, 'Reclassification of an inbound payment already received (accounting only): not new money', 'K1');
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, original_group_id,
      original_leg_ids, correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, 'K1', 'cfo_routed_receipt_to_custody', 'general_ledger', r.wallet_leg, r.orig_group, array[r.wallet_leg], v_grp,
      r.amount, r.amount, 0, jsonb_build_object('credit_reference', r.ref, 'payer', r.user_id,
      'basis', 'float-origin trace: used for the payer''s own portfolio'), c_cfo);
  end loop;

  -- 4. Checks.
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch;
  if v_n <> e.n or v_x <> e.amount then raise exception 'STOP: posted % / %', v_n, v_x; end if;
  if exists (select 1 from public.general_ledger g where g.idempotency_key like c_batch || ':%' and g.ledger_scope <> 'platform') then
    raise exception 'STOP: a correction leg is not platform-scope';
  end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.general_ledger where ledger_scope = 'wallet';
  if v_n <> s_wallet_legs or v_x <> s_wallet_sum then raise exception 'STOP: a wallet-scope ledger leg was written'; end if;
  if (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.investor_portfolios t) <> s_pf then
    raise exception 'STOP: a portfolio changed';
  end if;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
  values (c_cfo, 'accounting_correction_batch_posted', 'cfo_routed_receipt_to_custody', 'accounting_correction_register', c_batch,
    'Inbound payments routed by CFO Direct Credit to non-agents'' float, reclassified to cash held for the payer (accounting only)',
    jsonb_build_object('credits', e.n, 'amount', e.amount, 'transaction_date', v_mode));
  raise notice 'batch % posted: % credits, UGX %', c_batch, e.n, e.amount;
end $corr$;

commit;

-- ROLLBACK (only on CFO instruction): for each register row of this batch, post the same four legs with directions
-- swapped, idempotency key acct_corr_202611_cfo_routed:rb:<wallet leg id>, exclude from Money In, set rolled_back_at.
