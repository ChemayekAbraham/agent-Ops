DO $$
DECLARE
  v_user uuid := '9bb21b14-cf97-428d-960a-abdd244e80b8';
  v_group uuid := '8ebec258-66b3-401e-b017-a69908476957';
  v_row record;
  v_count int := 0;
  v_strict record;
  v_reason text := 'STEP0_AUDIT_MUWANGUZI_2026_05_12_FLOAT_SYMMETRY_FIX_REVERSAL_OF_ALREADY_RECLASSIFIED_ROUTE_REPAIR';
BEGIN
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_enforce_ledger_rpc_only;

  FOR v_row IN
    SELECT id, user_id, amount, direction, category, classification, wallet_bucket, description, transaction_group_id
    FROM public.general_ledger WHERE transaction_group_id = v_group
  LOOP
    INSERT INTO public.audit_logs (action_type, action, table_name, record_id, metadata, user_id)
    VALUES (
      'reclassify_to_admin_correction', 'reclassify_to_admin_correction',
      'general_ledger', v_row.id::text,
      jsonb_build_object(
        'reason', v_reason,
        'user_id', v_row.user_id, 'amount', v_row.amount, 'direction', v_row.direction,
        'category', v_row.category, 'wallet_bucket', v_row.wallet_bucket,
        'old_classification', v_row.classification, 'new_classification', 'admin_correction',
        'transaction_group_id', v_row.transaction_group_id, 'description', v_row.description
      ), v_user
    );
  END LOOP;

  UPDATE public.general_ledger SET classification = 'admin_correction'
  WHERE transaction_group_id = v_group AND classification <> 'admin_correction';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_enforce_ledger_rpc_only;

  SELECT * INTO v_strict FROM public.v_user_wallet_strict WHERE user_id = v_user;

  INSERT INTO public.audit_logs (action_type, action, table_name, record_id, metadata, user_id)
  VALUES (
    'wallet_recompute_after_reclassification', 'wallet_recompute_after_reclassification',
    'wallets', v_user::text,
    jsonb_build_object(
      'reason', v_reason,
      'new_withdrawable', COALESCE(v_strict.withdrawable, 0),
      'new_float',        COALESCE(v_strict.float_balance, 0),
      'new_advance',      COALESCE(v_strict.advance_balance, 0),
      'legs_reclassified', v_count
    ), v_user
  );

EXCEPTION WHEN OTHERS THEN
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_enforce_ledger_rpc_only;
  RAISE;
END $$;