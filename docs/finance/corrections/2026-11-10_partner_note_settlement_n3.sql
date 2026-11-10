-- PROMISSORY NOTE SETTLED BY FUND-IN — item N3 of batch acct_corr_202611_notes. CFO approval 10 Nov 2026:
-- "release note 0067f12b too" (UGX 4,000,000; its fund-in was recorded after the item-2 schedule).
--
-- ACCOUNTING RECORDS ONLY. NO MONEY MOVEMENT. settle_partner_receivable posts DR L2 partner_receivable_capital /
-- CR A7 partner_receivable_created for the part of the note settled by the capital fund-in the system attributes to
-- it. Bridge/platform legs only; no wallet, portfolio, note, fund-in, Returns or payout changes. Nothing is deleted.
-- Needs N1 posted. Any failed check aborts everything.
-- Rollback: 2026-11-10_partner_note_settlement_rollback.sql (counter-entries for the whole batch).
begin;

create temp table _n3 (note_id uuid primary key, release numeric not null) on commit drop;
insert into _n3 (note_id, release) values
  ('0067f12b-5778-42cf-ae2c-c72fc3b99933', 4000000)
;
create temp table _expected (n int not null, amount numeric not null) on commit drop;
insert into _expected values (1, 4000000);

do $corr$
declare
  c_batch constant text := 'acct_corr_202611_notes';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  r record; e record; v_n int; v_x numeric; v_res jsonb; s_wallet_legs bigint; s_wallet_sum numeric;
  s_wp text; s_wbp text; s_pf text; s_notes text; s_fi text; h text;
begin
  if to_regprocedure('public.settle_partner_receivable(uuid,text)') is null then
    raise exception 'STOP: apply migration 20261111100000 first';
  end if;
  if not exists (select 1 from public.accounting_correction_register where batch = c_batch and correction_item = 'N1') then
    raise exception 'STOP: post N1 first';
  end if;
  if exists (select 1 from public.accounting_correction_register where batch = c_batch and correction_item = 'N3') then
    raise exception 'STOP: N3 of batch % is already posted', c_batch;
  end if;

  -- 1. The schedule must be exactly what was approved, and each note must still need exactly that release.
  select * into e from _expected;
  select count(*), coalesce(sum(release), 0) into v_n, v_x from _n3;
  if v_n <> e.n or v_x <> e.amount then raise exception 'STOP: N3 input is % / %, approved % / %', v_n, v_x, e.n, e.amount; end if;
  for r in
    select x.note_id, x.release, v.outstanding, n.status,
           (select coalesce(sum(case when g.direction = 'cash_in' then g.amount else -g.amount end), 0) from public.general_ledger g
             where g.category = 'partner_receivable_created' and g.ledger_scope = 'bridge' and g.source_id = x.note_id) net
    from _n3 x left join public.v_partner_note_settlement v on v.note_id = x.note_id left join public.promissory_notes n on n.id = x.note_id
  loop
    if r.status is null or round(r.net - r.outstanding) <> r.release then
      raise exception 'STOP: note % changed since the schedule (needs %, schedule %)', r.note_id, round(r.net - r.outstanding), r.release;
    end if;
  end loop;

  -- 2. Money-safety snapshot.
  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into s_wp from public.wallets_physical t;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into s_wbp from public.wallet_balances_projection t;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_pf from public.investor_portfolios t;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_notes from public.promissory_notes t;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_fi from public.commission_fund_ins t;

  -- 3. Release each listed note through the same mechanism as N1.
  for r in select note_id, release from _n3 order by note_id loop
    v_res := public.settle_partner_receivable(r.note_id);
    if not coalesce((v_res->>'posted')::boolean, false) or (v_res->>'amount')::numeric <> r.release then
      raise exception 'STOP: note % did not release as scheduled: %', r.note_id, v_res;
    end if;
    if exists (select 1 from public.general_ledger g where g.transaction_group_id = (v_res->>'group_id')::uuid
                and (g.ledger_scope = 'wallet' or g.ledger_scope not in ('bridge', 'platform'))) then
      raise exception 'STOP: settlement group for note % is not bridge/platform only', r.note_id;
    end if;
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
    values ((v_res->>'group_id')::uuid, 'Promissory note settled by Supporter capital (accounting only): not money received', 'N3');
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, correction_group_id,
      amount, before_value, after_value, detail, created_by)
    values (c_batch, 'N3', 'settle_partner_receivable', 'promissory_notes', r.note_id, (v_res->>'group_id')::uuid, r.release,
      (v_res->>'net_before')::numeric, (v_res->>'outstanding')::numeric,
      jsonb_build_object('idempotency_key', v_res->>'idempotency_key', 'basis', v_res->>'basis'), c_cfo);
  end loop;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch and correction_item = 'N3';
  if v_n <> e.n or v_x <> e.amount then raise exception 'STOP: N3 posted % / %', v_n, v_x; end if;

  -- 4. Money-safety: nothing that holds or moves money changed.
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.general_ledger where ledger_scope = 'wallet';
  if v_n <> s_wallet_legs or v_x <> s_wallet_sum then raise exception 'STOP: a wallet-scope ledger leg was written'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into h from public.wallets_physical t;
  if h <> s_wp then raise exception 'STOP: wallets_physical changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into h from public.wallet_balances_projection t;
  if h <> s_wbp then raise exception 'STOP: wallet_balances_projection changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into h from public.investor_portfolios t;
  if h <> s_pf then raise exception 'STOP: a portfolio changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into h from public.promissory_notes t;
  if h <> s_notes then raise exception 'STOP: a promissory note changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into h from public.commission_fund_ins t;
  if h <> s_fi then raise exception 'STOP: a fund-in record changed'; end if;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
  values (c_cfo, 'accounting_correction_batch_posted', 'partner_note_settlement_n3', 'accounting_correction_register', c_batch,
    'Promissory notes settled by fund-ins, item N3 (accounting records only, no money movement)',
    jsonb_build_object('batch', c_batch, 'item', 'N3', 'notes', e.n, 'amount', e.amount));
  raise notice 'batch % item N3 posted: % notes, UGX %', c_batch, e.n, e.amount;
end $corr$;

commit;
