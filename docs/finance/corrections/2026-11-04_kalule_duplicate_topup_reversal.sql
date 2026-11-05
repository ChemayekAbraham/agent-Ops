-- KALULE SHARIF (3f87c1f3): return the duplicate UGX 1,500,000 paid by the 28 Oct top-up.
-- CFO decision 2026-11-04 (Sarah Angwen): take the money back from the withdrawable wallet; advance c73ab9a3 keeps
-- principal 3,211,526 / outstanding 3,231,526, because the top-up carried advance 288cbab8's debt (paid 27 Oct, withdrawn
-- 28 Oct TID160002049854) into it. The second wallet credit (group 6031b0f6, top-up 47e68d14) was the duplicate.
--
-- One balanced group, key adv_dup_payout_reversal:47e68d14-0ecc-43cc-92f6-7f4f0b482638 (posts once only):
--   wallet   cash_out 1,500,000 agent_advance_reversed  withdrawable  -> DR L1 Wallet custody (his wallet -1,500,000)
--   platform cash_in  1,500,000 agent_advance_reversed                 -> CR A10 advance receivable (advance 288cbab8)
-- After: 288cbab8 A10 1,500,000 -> 0; c73ab9a3 books A10 3,211,526 + A20 20,000 = 3,231,526 = its record.
-- No advance, top-up, withdrawal or earlier ledger row is changed. Any failed check aborts everything.

begin;

do $$
declare
  k constant uuid := '3f87c1f3-6564-478d-a08d-43da24614c80';
  w record; a record; b record; n int;
  v_key constant text := 'adv_dup_payout_reversal:47e68d14-0ecc-43cc-92f6-7f4f0b482638';
  v_group uuid;
begin
  select * into w from public.wallets where user_id = k;
  perform 1 from public.wallets_physical where user_id = k for update;
  if w.withdrawable_balance < 1500000 then raise exception 'STOP: withdrawable is %, not >= 1,500,000', w.withdrawable_balance; end if;
  select count(*) into n from public.withdrawal_requests where user_id = k and status in ('pending','approved','processing','re_approved_for_recovery');
  if n > 0 then raise exception 'STOP: % open withdrawal request(s)', n; end if;
  select * into a from public.agent_advances where id = 'c73ab9a3-c2db-4ec7-9642-c4d1866d3ac1';
  if a.status <> 'active' or a.principal <> 3211526 or a.outstanding_balance <> 3231526 then
    raise exception 'STOP: c73ab9a3 changed (status %, principal %, outstanding %)', a.status, a.principal, a.outstanding_balance; end if;
  select * into b from public.agent_advances where id = '288cbab8-0c82-4ac6-9632-11c44e724ef4';
  if b.status <> 'cancelled' or b.outstanding_balance <> 0 then raise exception 'STOP: 288cbab8 changed'; end if;
  select count(*) into n from public.general_ledger where transaction_group_id = '6031b0f6-e733-43bf-b16e-52cbc7920102'
    and ledger_scope = 'wallet' and direction = 'cash_in' and amount = 1500000 and user_id = k;
  if n <> 1 then raise exception 'STOP: duplicate top-up credit not found as expected'; end if;
  select count(*) into n from public.general_ledger where idempotency_key = v_key
    or (user_id = k and category = 'agent_advance_reversed');
  if n > 0 then raise exception 'STOP: a reversal is already posted'; end if;

  v_group := public.create_ledger_transaction(entries => jsonb_build_array(
    jsonb_build_object('user_id', k, 'ledger_scope', 'wallet', 'direction', 'cash_out', 'amount', 1500000,
      'category', 'agent_advance_reversed', 'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
      'source_table', 'agent_advances', 'source_id', '288cbab8-0c82-4ac6-9632-11c44e724ef4',
      'reference_id', '6031b0f6-e733-43bf-b16e-52cbc7920102', 'currency', 'UGX',
      'description', 'Duplicate advance payout returned: top-up 47e68d14 on 28 Oct paid UGX 1,500,000 again for advance 288cbab8 (paid 27 Oct, debt carried on c73ab9a3). CFO approved 4 Nov 2026.'),
    jsonb_build_object('user_id', k, 'ledger_scope', 'platform', 'direction', 'cash_in', 'amount', 1500000,
      'category', 'agent_advance_reversed',
      'source_table', 'agent_advances', 'source_id', '288cbab8-0c82-4ac6-9632-11c44e724ef4',
      'reference_id', '6031b0f6-e733-43bf-b16e-52cbc7920102', 'currency', 'UGX',
      'description', 'Advance receivable reduced: duplicate payout of advance 288cbab8 (top-up 47e68d14, group 6031b0f6) returned from the wallet.')),
    idempotency_key => v_key);

  insert into public.audit_logs (user_id, actor_id, performed_by, action_type, table_name, record_id, reason, metadata)
  values ('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b',
    'agent_advance_duplicate_payout_reversed', 'agent_advances', '288cbab8-0c82-4ac6-9632-11c44e724ef4',
    'Duplicate UGX 1,500,000 paid by top-up 47e68d14 (28 Oct) returned from KALULE SHARIF''s wallet; c73ab9a3 keeps 3,231,526 owed',
    jsonb_build_object('agent_id', k, 'amount', 1500000, 'ledger_group_id', v_group, 'idempotency_key', v_key,
      'duplicate_group', '6031b0f6-e733-43bf-b16e-52cbc7920102', 'topup_id', '47e68d14-0ecc-43cc-92f6-7f4f0b482638',
      'original_advance', '288cbab8-0c82-4ac6-9632-11c44e724ef4', 'carried_on', 'c73ab9a3-c2db-4ec7-9642-c4d1866d3ac1',
      'wallet_before', w.withdrawable_balance, 'approved_by', 'CFO in chat 2026-11-04'));

  select * into w from public.wallets where user_id = k;
  if w.withdrawable_balance <> 0 then raise exception 'STOP: wallet after is %, expected 0', w.withdrawable_balance; end if;
  raise notice 'posted group %', v_group;
end $$;

commit;
