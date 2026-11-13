-- CASH DEPOSIT CASHREQ-2660d454 (3 Nov 2026) RECORDED AT 1,005,000,000 — batch acct_corr_202611_cash1005.
-- CFO approval 10 Nov 2026: "the real amount was 100,000,000, approve the correction".
--
-- ACCOUNTING RECORDS ONLY. NO MONEY MOVEMENT. Platform-scope journals only: no wallet leg, no wallet, deposit,
-- portfolio or payout change; nothing is deleted.
--
-- What happened (production, read-only, 10 Nov 2026):
--   • deposit_requests c18ee41c-41fd-4d05-ab5e-ebaa2fed0e14, cash_deposit, 1,005,000,000, "Cash owner: cherotich sherry",
--     recorded and approved by the same operator. Equity shows 100,000,000 on 2 Nov (A5F7EDEE09A48); the Supporter's
--     portfolio WIP2611038450 is 100,000,000.
--   • Posted DR A5 cash_receipt_in_transit / CR L1 cash_custody_payable 1,005,000,000 (A2 legs net to zero).
--   • Same day, 7 operator moves (ECW-*) removed 900,538,843 of the float to the platform bucket:
--     DR X6 system_balance_correction / CR A2 — a loss that did not happen.
-- Correction (real amount R, excess E = 1,005,000,000 − R):
--   C1  DR L1 cash_custody_payable / CR A5 cash_receipt_in_transit                E
--   C2  DR A2 agent_float_cash_offset / CR X6 float_restatement_correction         min(900,538,843, E)
--       (needs migration 20261111110000: X6 is otherwise reachable only with a wallet leg)
--   Any excess not removed (E − 900,538,843; 4,461,157 if R = 100,000,000) is float handed on without cash behind it:
--   reported, not posted — it needs a separate decision.
-- Rollback: counter-entries with the same categories, opposite directions (see the end of this file).
begin;

-- INPUT 1: the real amount received for this deposit, confirmed by the CFO. NULL = stop.
create temp table _params (key text primary key, value text) on commit drop;
insert into _params values ('confirmed_real_amount', '100000000'), ('transaction_date', '2026-11-03 11:45:27+03');  -- CFO confirmed 10 Nov 2026

do $corr$
declare
  c_batch constant text := 'acct_corr_202611_cash1005';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  c_dep   constant uuid := 'c18ee41c-41fd-4d05-ab5e-ebaa2fed0e14';
  c_recorded constant numeric := 1005000000;
  c_removed  constant numeric := 900538843;
  v_real numeric; v_excess numeric; v_c2 numeric; v_td timestamptz; v_g1 uuid; v_g2 uuid; v_n bigint; v_x numeric;
  s_wallet_legs bigint; s_wallet_sum numeric; v_dep record; v_removed numeric; v_orig uuid;
begin
  v_real := (select value from _params where key = 'confirmed_real_amount')::numeric;
  if v_real is null then raise exception 'STOP: confirmed_real_amount is not set (CFO confirmation required)'; end if;
  if v_real < 0 or v_real >= c_recorded then raise exception 'STOP: confirmed amount % outside 0..%', v_real, c_recorded; end if;
  v_excess := c_recorded - v_real;
  v_c2 := least(c_removed, v_excess);
  v_td := (select value from _params where key = 'transaction_date')::timestamptz;
  if exists (select 1 from public.accounting_correction_register where batch = c_batch) then
    raise exception 'STOP: batch % is already posted', c_batch;
  end if;
  if not exists (select 1 from public.ledger_account_map where ledger_scope = 'platform' and category = 'float_restatement_correction' and account_code = 'X6') then
    raise exception 'STOP: apply migration 20261111110000 first (float_restatement_correction -> X6)';
  end if;

  -- 1. Production must still show what the schedule describes.
  select id, amount, status, provider into v_dep from public.deposit_requests where id = c_dep;
  if v_dep.id is null or v_dep.amount <> c_recorded or v_dep.status <> 'approved' or v_dep.provider <> 'cash_deposit' then
    raise exception 'STOP: deposit % changed (%, %, %)', c_dep, v_dep.amount, v_dep.status, v_dep.provider;
  end if;
  select g.transaction_group_id into v_orig from public.general_ledger g
   where g.source_id = c_dep and g.category = 'cash_receipt_in_transit' and g.direction = 'cash_in' and g.amount = c_recorded;
  if v_orig is null then raise exception 'STOP: original A5 leg for % not found', c_dep; end if;
  select coalesce(sum(g.amount), 0) into v_removed from public.general_ledger g
   where g.user_id = '59d45ad2-0d44-433c-b4ec-20927a25c281' and g.ledger_scope = 'wallet' and g.wallet_bucket = 'float'
     and g.direction = 'cash_out' and g.reference_id like 'ECW-%' and g.transaction_date >= '2026-11-03' and g.transaction_date < '2026-11-04';
  if v_removed <> c_removed then raise exception 'STOP: float removed on 3 Nov is %, schedule says %', v_removed, c_removed; end if;

  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';

  -- 2. C1: remove the cash that was never received from A5, and the matching custody liability from L1.
  v_g1 := public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_excess, 'category', 'cash_receipt_in_transit',
      'source_table', 'deposit_requests', 'source_id', c_dep::text, 'reference_id', v_orig::text, 'currency', 'UGX',
      'transaction_date', v_td, 'classification', 'production',
      'description', format('Correction (accounting only, no money moved): cash deposit CASHREQ-2660d454 was recorded as UGX %s; the CFO confirmed UGX %s was received. Removes the UGX %s never received from cash in transit.', c_recorded, v_real, v_excess)),
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_excess, 'category', 'cash_custody_payable',
      'source_table', 'deposit_requests', 'source_id', c_dep::text, 'reference_id', v_orig::text, 'currency', 'UGX',
      'transaction_date', v_td, 'classification', 'production',
      'description', format('Correction (accounting only, no money moved): removes the custody obligation recorded for UGX %s of cash deposit CASHREQ-2660d454 that was never received.', v_excess))),
    idempotency_key := c_batch || ':C1');

  -- 3. C2: reverse the false loss booked when the excess float was removed.
  v_g2 := public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_c2, 'category', 'agent_float_cash_offset',
      'source_table', 'deposit_requests', 'source_id', c_dep::text, 'reference_id', v_orig::text, 'currency', 'UGX',
      'transaction_date', v_td, 'classification', 'production',
      'description', format('Correction (accounting only, no money moved): the UGX %s of float removed on 3 Nov (ECW moves) came from the over-recorded cash deposit CASHREQ-2660d454; it was not a float loss. Restores agent float.', v_c2)),
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_c2, 'category', 'float_restatement_correction',
      'source_table', 'deposit_requests', 'source_id', c_dep::text, 'reference_id', v_orig::text, 'currency', 'UGX',
      'transaction_date', v_td, 'classification', 'production',
      'description', format('Correction (accounting only, no money moved): reverses the UGX %s float restatement loss booked on 3 Nov for float that never existed (deposit CASHREQ-2660d454 over-recorded).', v_c2))),
    idempotency_key := c_batch || ':C2');

  -- 4. Register, Money In exclusion, safety.
  insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
  values (v_g1, 'Correction of an over-recorded cash deposit (accounting only): not money received', 'C1'),
         (v_g2, 'Correction of a float restatement loss (accounting only): not money received', 'C2');
  insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, original_group_id,
    correction_group_id, amount, before_value, after_value, detail, created_by)
  values (c_batch, 'C1', 'contra_over_recorded_cash_deposit', 'deposit_requests', c_dep, v_orig, v_g1, v_excess, c_recorded, v_real,
          jsonb_build_object('equity_credit', 'A5F7EDEE09A48 2026-11-02 100,000,000', 'confirmed_by_cfo', v_real), c_cfo),
         (c_batch, 'C2', 'reverse_false_float_loss', 'deposit_requests', c_dep, v_orig, v_g2, v_c2, c_removed, c_removed - v_c2,
          jsonb_build_object('float_removed_refs', 'ECW-* 2026-11-03', 'residual_float_without_cash', v_excess - v_c2), c_cfo);
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.general_ledger where ledger_scope = 'wallet';
  if v_n <> s_wallet_legs or v_x <> s_wallet_sum then raise exception 'STOP: a wallet-scope ledger leg was written'; end if;
  if exists (select 1 from public.general_ledger g where g.idempotency_key like c_batch || ':%' and g.ledger_scope <> 'platform') then
    raise exception 'STOP: correction is not platform-only';
  end if;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
  values (c_cfo, 'accounting_correction_batch_posted', 'cash_deposit_overstatement', 'accounting_correction_register', c_batch,
    'Over-recorded cash deposit CASHREQ-2660d454 (accounting records only, no money movement)',
    jsonb_build_object('recorded', c_recorded, 'confirmed', v_real, 'C1', v_excess, 'C2', v_c2, 'residual_float_without_cash', v_excess - v_c2));
  raise notice 'batch % posted: C1 %, C2 %, residual float without cash % (not posted)', c_batch, v_excess, v_c2, v_excess - v_c2;
end $corr$;

commit;

-- ROLLBACK (run separately, only on CFO instruction): post the same two groups with directions swapped, idempotency keys
-- acct_corr_202611_cash1005:C1:rb and :C2:rb, exclude them from Money In and set rolled_back_at in the register.
