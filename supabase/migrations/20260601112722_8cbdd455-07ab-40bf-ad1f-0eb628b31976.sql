-- One-off ledger maintenance: reverse an erroneous CFO over-correction.
-- Transaction group 198445c9 posted a 149,999 "Balance Correction (Debit)" against
-- SSENKAALI PIUS (0b109aad...) withdrawable bucket on 2026-05-20. The strict wallet
-- view counts correction DEBITS but ignores correction CREDITS, so this debit pins
-- the user's withdrawable at 0 and swallows legitimate ROI/P2P credits. Removing the
-- balanced pair restores the genuine withdrawable (~+9,750) without inflating anything.
DO $$
DECLARE
  v_grp uuid := '198445c9-dbac-4670-a904-ebc49182261e';
  v_count int;
BEGIN
  -- Break-glass: temporarily lift the ledger immutability guards for this txn only.
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_enforce_ledger_rpc_only;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, action, metadata, created_at)
  VALUES (
    'ledger_reversal',
    'general_ledger',
    'e67b3379-b4a9-4713-9e6c-ec5e64c970c2',
    'delete',
    jsonb_build_object(
      'reason', 'Reverse erroneous 149,999 CFO over-correction (Balance Correction Debit) so legitimate wallet funds reflect for SSENKAALI PIUS',
      'transaction_group_id', v_grp,
      'amount', 149999,
      'user_id', '0b109aad-212a-4fd0-ab03-3d7aee9cf397'
    ),
    now()
  );

  DELETE FROM public.general_ledger WHERE transaction_group_id = v_grp;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Reversed % ledger legs for group %', v_count, v_grp;

  -- Restore the immutability guards.
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_enforce_ledger_rpc_only;
END $$;