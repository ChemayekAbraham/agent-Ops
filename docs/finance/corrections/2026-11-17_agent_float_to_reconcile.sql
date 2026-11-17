-- AGENT FLOAT TO BE RECONCILED — batch acct_corr_202611_agent_float_a30. DRAFT, not approved.
--
-- ACCOUNTING RECORDS ONLY. NO MONEY MOVEMENT. Platform-scope journals only: no wallet leg; no wallet, deposit,
-- collection or portfolio record changes; nothing is deleted. Runs AFTER migration 20261127120000.
--
-- CFO decision 17 Nov 2026: agent float (A2) is what agents hold in their float wallets. After migration
-- 20261127120000 moves Partner top-ups paid from float (A28), restated tenant collections (A29) and the
-- agent-facilitated capital receivable (A31) out of A2, agent float is still UGX 344,680,581 above the float wallets
-- (traced 17 Nov 2026, read-only). That rest moves to A30 "Agent float to be reconciled" in three dated parts:
--   apr_jul     - 140,596,097: float deposits (370,598,304) less float used and settled (230,002,207) recorded from
--                 April to July 2026 without a wallet bucket (before float wallets existed); dated 31 Jul 2026;
--   corrections - 178,061,884: admin corrections, merchant float reconciliations and CFO credits that changed float
--                 wallets without reaching the statements (net of the 52,110,000 moved into agent float on 16 Nov);
--                 dated 17 Nov 2026;
--   other       -  26,022,600: other small differences, including Partner top-ups from float in entries kept out of the
--                 statements (1,530,000); dated 17 Nov 2026.
-- Each part: DR A30 agent_float_to_reconcile / CR A2 agent_float_to_reconcile_from_a2.
-- Check: afterwards agent float (A2) equals the float wallets within UGX 1,000,000, or nothing is posted.
-- Rollback: the same groups with directions swapped (see the end of this file).
begin isolation level repeatable read;

create temp table _p (item text primary key, amount numeric not null, at timestamptz not null, label text not null) on commit drop;
insert into _p values
  ('apr_jul',     140596097, '2026-07-31 23:59:00+03', 'April-July 2026 float entries recorded without a wallet bucket'),
  ('corrections', 178061884, now(),                    'Admin corrections, merchant float reconciliations and CFO credits on float wallets'),
  ('other',        26022600, now(),                    'Other agent float differences');

do $corr$
declare
  c_batch constant text := 'acct_corr_202611_agent_float_a30';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  r record; v_grp uuid; v_n int; v_x numeric; v_a2 numeric; v_fl numeric;
  s_wallet_legs bigint; s_wallet_sum numeric;
begin
  if not exists (select 1 from public.ledger_account_catalog where code = 'A30') then
    raise exception 'STOP: migration 20261127120000 is not installed';
  end if;
  if exists (select 1 from public.accounting_correction_register where batch = c_batch) then
    raise exception 'STOP: batch % is already posted', c_batch;
  end if;
  if (select count(*) from _p) <> 3 or (select sum(amount) from _p) <> 344680581 then
    raise exception 'STOP: input does not match the approved totals';
  end if;

  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';

  for r in select * from _p order by at, item loop
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount, 'category', 'agent_float_to_reconcile',
        'source_table', 'agent_float_trace', 'reference_id', c_batch || ':' || r.item, 'currency', 'UGX', 'classification', 'production',
        'transaction_date', r.at,
        'description', format('Correction (accounting only, no money moved): %s moved to Agent float to be reconciled (UGX %s)', r.label, r.amount)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'agent_float_to_reconcile_from_a2',
        'source_table', 'agent_float_trace', 'reference_id', c_batch || ':' || r.item, 'currency', 'UGX', 'classification', 'production',
        'transaction_date', r.at,
        'description', 'Correction (accounting only, no money moved): taken out of agent float so it matches the float wallets')),
      c_batch || ':' || r.item, false);
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id,
      correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, r.item, 'agent_float_to_reconcile', 'agent_float_trace', md5(c_batch || ':' || r.item)::uuid,
      v_grp, r.amount, r.amount, 0, jsonb_build_object('label', r.label, 'dated', r.at), c_cfo);
  end loop;

  -- Checks.
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch;
  if v_n <> 3 or v_x <> 344680581 then raise exception 'STOP: posted % / %', v_n, v_x; end if;
  if exists (select 1 from public.general_ledger g where g.idempotency_key like c_batch || ':%' and g.ledger_scope <> 'platform') then
    raise exception 'STOP: a correction leg is not platform-scope';
  end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.general_ledger where ledger_scope = 'wallet';
  if v_n <> s_wallet_legs or v_x <> s_wallet_sum then raise exception 'STOP: a wallet-scope ledger leg was written'; end if;
  select coalesce(sum(dr - cr), 0) into v_a2 from public.sofp_ledger_legs(now()) where account_code = 'A2';
  select coalesce(sum(float_balance), 0) into v_fl from public.wallet_balances_projection;
  if abs(v_a2 - v_fl) > 1000000 then
    raise exception 'STOP: agent float % vs float wallets % (difference %); re-derive the batch', round(v_a2), round(v_fl), round(v_a2 - v_fl);
  end if;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
  values (c_cfo, 'accounting_correction_batch_posted', 'agent_float_to_reconcile', 'accounting_correction_register', c_batch,
    'Agent float history not matched by float wallets moved to Agent float to be reconciled (accounting only)',
    jsonb_build_object('amount', 344680581, 'agent_float_after', round(v_a2), 'float_wallets', round(v_fl)));
  raise notice 'batch % posted: 3 parts / UGX 344,680,581; agent float % vs float wallets %', c_batch, round(v_a2), round(v_fl);
end $corr$;

commit;

-- ROLLBACK (only on CFO instruction): for each register row of this batch, post the same legs with directions swapped,
-- idempotency key acct_corr_202611_agent_float_a30:rb:<register id>, dated today, and set rolled_back_at.
