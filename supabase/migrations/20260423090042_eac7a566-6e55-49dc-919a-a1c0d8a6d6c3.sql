DO $$
DECLARE
  v_user_id uuid := 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c';
  v_amount  numeric := 1000000;
  v_group   uuid := gen_random_uuid();
  v_now     timestamptz := now();
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE user_id = v_user_id AND ledger_scope = 'wallet'
  ) THEN
    RAISE NOTICE 'User % already has wallet ledger entries, skipping back-fill', v_user_id;
    RETURN;
  END IF;

  INSERT INTO public.general_ledger (
    user_id, amount, direction, category, ledger_scope, description,
    currency, source_table, transaction_date, classification, txn_group_id
  ) VALUES (
    v_user_id, v_amount, 'cash_in', 'admin_correction', 'wallet',
    'Opening equity back-fill — phantom wallet reconciliation (pre-ledger balance)',
    'UGX', 'admin_corrections', v_now, 'admin_correction', v_group
  );

  INSERT INTO public.general_ledger (
    amount, direction, category, ledger_scope, description,
    currency, source_table, transaction_date, classification, txn_group_id
  ) VALUES (
    v_amount, 'cash_out', 'admin_correction', 'platform',
    'Opening equity back-fill — phantom wallet reconciliation (pre-ledger balance)',
    'UGX', 'admin_corrections', v_now, 'admin_correction', v_group
  );
END $$;