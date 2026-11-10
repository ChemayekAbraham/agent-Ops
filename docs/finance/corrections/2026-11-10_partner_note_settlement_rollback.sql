-- ROLLBACK for batch acct_corr_202611_notes. Counter-entries only; nothing is deleted. DRAFT.
-- Revokes the CFO confirmations (so the settlement rule no longer counts them) and re-recognises each released
-- amount: DR A7 partner_receivable_created / CR L2 partner_receivable_capital. Bridge/platform legs only; no money moves.
begin;
do $rb$
declare
  c_batch constant text := 'acct_corr_202611_notes';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  r record; v_grp uuid;
begin
  if not exists (select 1 from public.accounting_correction_register where batch = c_batch and rolled_back_at is null) then
    raise exception 'STOP: nothing of batch % to roll back', c_batch;
  end if;
  update public.partner_note_settlements
     set revoked_at = now(), revoked_by = c_cfo, revoke_reason = 'Rollback of batch ' || c_batch
   where revoked_at is null and basis = 'cfo_confirmed'
     and note_id in (select source_id from public.accounting_correction_register where batch = c_batch and correction_item = 'N1');
  for r in select * from public.accounting_correction_register where batch = c_batch and rolled_back_at is null order by created_at, id loop
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('amount', r.amount, 'direction', 'cash_in', 'category', 'partner_receivable_created', 'ledger_scope', 'bridge',
        'classification', 'production', 'source_table', 'promissory_notes', 'source_id', r.source_id, 'reference_id', r.correction_group_id::text,
        'description', 'Rollback of A7 settlement ' || r.correction_group_id::text || ' (batch ' || c_batch || '): receivable restored.'),
      jsonb_build_object('amount', r.amount, 'direction', 'cash_out', 'category', 'partner_receivable_capital', 'ledger_scope', 'platform',
        'classification', 'production', 'source_table', 'promissory_notes', 'source_id', r.source_id, 'reference_id', r.correction_group_id::text,
        'description', 'Rollback of A7 settlement ' || r.correction_group_id::text || ' (batch ' || c_batch || '): Supporter capital on the note restored.')),
      'partner_recv_settle_rb:' || r.correction_group_id::text, false);
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item, reverses_group_id)
    values (v_grp, 'Rollback of a promissory note settlement (accounting only)', r.correction_item, r.correction_group_id);
    update public.accounting_correction_register set rolled_back_at = now(), rebook_group_id = v_grp where id = r.id;
  end loop;
end $rb$;
commit;
