-- ROLLBACK of batch acct_corr_202611 (September 2026 rent-collection accounting corrections).
-- The General Ledger is append-only, so nothing is deleted: every correction journal gets an exact counter-entry
-- (keys acct_corr_202611:rollback:*), tenant balances get the credit taken back (only where nothing has changed since),
-- C3 allocations lose their reversal link, and Money In exclusions for the ORIGINAL groups are removed so the books and
-- the report return to their pre-correction state. The register keeps every row, stamped rolled_back_at.
-- Accounting only: no wallet, payment or collection is touched. Needs CFO approval like the batch itself.
begin;
do $rb$
declare
  c_batch constant text := 'acct_corr_202611';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  r record; g uuid; v_grp uuid; v_legs jsonb; v_n int; s_wallet_legs bigint;
begin
  if not exists (select 1 from public.accounting_correction_register where batch = c_batch and rolled_back_at is null) then
    raise exception 'STOP: nothing to roll back for %', c_batch;
  end if;
  select count(*) into s_wallet_legs from public.general_ledger where ledger_scope = 'wallet';

  for r in select * from public.accounting_correction_register where batch = c_batch and rolled_back_at is null order by created_at, id loop
    if r.correction_item = 'A' then
      perform set_config('welile.balance_edit_source', 'acct_corr_202611_rollback', true);
      update public.rent_requests set amount_repaid = amount_repaid - r.amount where id = r.source_id and amount_repaid = r.after_value;
      get diagnostics v_n = row_count;
      if v_n <> 1 then raise exception 'STOP: Rent Plan % has moved since the correction; roll it back by hand', r.source_id; end if;
      update public.accounting_correction_register set rolled_back_at = now() where id = r.id;
      continue;
    end if;
    -- counter-entry for the correction group and (C2) the rebook group
    foreach g in array array_remove(array[r.correction_group_id, r.rebook_group_id], null) loop
      select jsonb_agg(jsonb_build_object('ledger_scope', l.ledger_scope,
               'direction', case l.direction when 'cash_in' then 'cash_out' else 'cash_in' end,
               'amount', l.amount, 'category', l.category, 'source_table', l.source_table, 'source_id', l.source_id::text,
               'reference_id', g::text, 'currency', 'UGX', 'transaction_date', l.transaction_date, 'classification', 'production',
               'description', 'Rollback of correction group ' || g::text || ' (batch ' || c_batch || ')') order by l.created_at, l.id)
        into v_legs from public.general_ledger l where l.transaction_group_id = g;
      if exists (select 1 from public.general_ledger l where l.transaction_group_id = g and l.ledger_scope <> 'platform') then
        raise exception 'STOP: group % is not platform-only', g;
      end if;
      v_grp := public.create_ledger_transaction(entries := v_legs, idempotency_key := c_batch || ':rollback:' || g::text);
      insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item, reverses_group_id)
      values (v_grp, 'Rollback of an accounting correction: not money received', 'rollback', g) on conflict do nothing;
      -- the undone group (e.g. a C2 rebook) no longer counts either
      insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
      values (g, 'Accounting correction rolled back: not money received', 'rollback') on conflict do nothing;
    end loop;
    -- the original group counts again in Money In (C2/C3); the B original never did
    if r.correction_item in ('C2', 'C3') then
      delete from public.money_in_report_exclusions where transaction_group_id = r.original_group_id and correction_item in ('C2', 'C3', 'auto');
    end if;
    if r.correction_item = 'C3' then
      update public.instalment_allocations set reversal_group_id = null where id = r.source_id and reversal_group_id = r.correction_group_id;
    end if;
    update public.accounting_correction_register set rolled_back_at = now(), rollback_group_id = v_grp where id = r.id;
  end loop;

  if (select count(*) from public.general_ledger where ledger_scope = 'wallet') <> s_wallet_legs then
    raise exception 'STOP: a wallet-scope ledger leg was written';
  end if;
  insert into public.audit_logs (user_id, actor_id, performed_by, action_type, table_name, record_id, reason, metadata)
  values (c_cfo, c_cfo, c_cfo, 'accounting_correction_batch_rolled_back', 'accounting_correction_register', c_batch,
    'Rollback of the September 2026 rent-collection accounting corrections (counter-entries; nothing deleted)',
    jsonb_build_object('batch', c_batch, 'rows', (select count(*) from public.accounting_correction_register where batch = c_batch)));
end $rb$;
commit;
