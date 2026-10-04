DO $$
DECLARE
  v_actor uuid := '0b109aad-212a-4fd0-ab03-3d7aee9cf397'; -- manager: SSENKAALI PIUS
  v_user  uuid := 'fbb80a4f-8d28-46b8-b93c-7e65f1b549c7';
  v_ids uuid[] := ARRAY[
    'a91dcf04-8425-40bd-af28-2def72a3b81c',
    'd52a47bb-7ef2-4265-ba97-234d1f0befc7',
    '28de7a69-ff57-47e5-93e7-04fbcc005929',
    '18afc314-242f-47f3-99d5-4ddcfd70d856',
    '690f54dd-9153-4d5a-8d32-61c45d364914',
    '631ef47d-c2ad-4d65-ae12-ff05833af9e7'
  ]::uuid[];
  v_reason text := 'Reversal of erroneous 2026-06-23 withdrawable wallet retraction (1,590,000) for Brenda Stella Nantaayi; restores legitimate commissions incl. PAY-MQZ3MV17-6UIT';
BEGIN
  INSERT INTO public.voided_ledger_entries (
    original_ledger_id, transaction_date, amount, direction, category,
    description, reference_id, linked_party, running_balance, user_id,
    source_table, source_id, account, transaction_group_id, voided_by, void_reason
  )
  SELECT id, transaction_date, amount, direction, category,
         description, reference_id, linked_party, running_balance, user_id,
         source_table, source_id, account, transaction_group_id, v_actor, v_reason
  FROM public.general_ledger
  WHERE id = ANY(v_ids);

  PERFORM set_config('ledger.bypass_guard', 'true', true);
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;
  DELETE FROM public.general_ledger WHERE id = ANY(v_ids);
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
  PERFORM set_config('ledger.bypass_guard', 'false', true);

  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE public.wallets
     SET withdrawable_balance = 980000,
         float_balance        = 0,
         advance_balance      = 0,
         balance              = 980000,
         updated_at           = now()
   WHERE user_id = v_user;
  PERFORM set_config('wallet.sync_authorized', 'false', true);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (
    v_actor,
    'wallet_erroneous_retraction_reversal',
    'general_ledger',
    v_user::text,
    'void_and_restore',
    jsonb_build_object(
      'reason', v_reason,
      'voided_ledger_ids', v_ids,
      'restored_withdrawable', 980000,
      'reference', 'PAY-MQZ3MV17-6UIT'
    )
  );
END $$;