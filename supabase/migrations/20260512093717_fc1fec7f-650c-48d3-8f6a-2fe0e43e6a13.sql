DO $$
DECLARE
  v_user uuid := '9bb21b14-cf97-428d-960a-abdd244e80b8';
  v_groups uuid[] := ARRAY[
    '2892c1e1-fb49-4b2b-99f4-9999c7c0cd4f'::uuid,
    '2deecd91-2f65-47c3-81f7-d2c8593baf46'::uuid,
    'e685095d-6ff4-4218-bfd6-627afcda75e7'::uuid,
    'ca6e8923-66fe-4213-9906-8f263453134c'::uuid,
    '2f44407d-abfc-41d2-873d-46e768fbf4d4'::uuid
  ];
  v_row record;
  v_count int := 0;
  v_strict record;
  v_reason text := 'STEP0_AUDIT_MUWANGUZI_2026_05_12_PHANTOM_AND_DUPLICATE_DEBITS_REMOVED_PER_CFO_SIGNOFF';
BEGIN
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_enforce_ledger_rpc_only;

  FOR v_row IN
    SELECT id, user_id, amount, direction, category, classification, wallet_bucket, description, transaction_group_id
    FROM public.general_ledger
    WHERE transaction_group_id = ANY(v_groups)
  LOOP
    INSERT INTO public.audit_logs (action_type, action, table_name, record_id, metadata, user_id)
    VALUES (
      'reclassify_to_admin_correction',
      'reclassify_to_admin_correction',
      'general_ledger',
      v_row.id::text,
      jsonb_build_object(
        'reason', v_reason,
        'user_id', v_row.user_id,
        'amount', v_row.amount,
        'direction', v_row.direction,
        'category', v_row.category,
        'wallet_bucket', v_row.wallet_bucket,
        'old_classification', v_row.classification,
        'new_classification', 'admin_correction',
        'transaction_group_id', v_row.transaction_group_id,
        'description', v_row.description
      ),
      v_user
    );
  END LOOP;

  UPDATE public.general_ledger
  SET classification = 'admin_correction'
  WHERE transaction_group_id = ANY(v_groups)
    AND classification <> 'admin_correction';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_enforce_ledger_rpc_only;

  SELECT * INTO v_strict FROM public.v_user_wallet_strict WHERE user_id = v_user;

  INSERT INTO public.audit_logs (action_type, action, table_name, record_id, metadata, user_id)
  VALUES (
    'wallet_recompute_after_reclassification',
    'wallet_recompute_after_reclassification',
    'wallets',
    v_user::text,
    jsonb_build_object(
      'reason', v_reason,
      'new_withdrawable', COALESCE(v_strict.withdrawable, 0),
      'new_float',        COALESCE(v_strict.float_balance, 0),
      'new_advance',      COALESCE(v_strict.advance_balance, 0),
      'legs_reclassified', v_count,
      'transaction_groups', v_groups
    ),
    v_user
  );

EXCEPTION WHEN OTHERS THEN
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_enforce_ledger_rpc_only;
  RAISE;
END $$;