
DO $$
DECLARE
  v_affected_users uuid[];
  v_row_count int;
BEGIN
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_enforce_ledger_rpc_only;

  SELECT ARRAY(
    SELECT DISTINCT user_id
    FROM public.general_ledger
    WHERE category IN ('system_balance_correction','wallet_route_repair','admin_adjustment')
      AND classification = 'production'
  ) INTO v_affected_users;

  UPDATE public.general_ledger
     SET classification = 'admin_correction'
   WHERE category IN ('system_balance_correction','wallet_route_repair','admin_adjustment')
     AND classification = 'production';
  GET DIAGNOSTICS v_row_count = ROW_COUNT;

  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_enforce_ledger_rpc_only;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, metadata)
  VALUES (
    'float_permanent_fix_bulk_backfill',
    'general_ledger',
    gen_random_uuid(),
    jsonb_build_object(
      'reason',            'Backfill admin maintenance rows from production to admin_correction across all users (Step 0 + Fix 1 of float_permanent_fix.md). The wallets view auto-reflects the strict ledger so balances refresh without an explicit re-snap.',
      'rows_reclassified', v_row_count,
      'users_affected',    COALESCE(array_length(v_affected_users, 1), 0),
      'categories',        ARRAY['system_balance_correction','wallet_route_repair','admin_adjustment'],
      'plan_reference',    'float_permanent_fix.md'
    )
  );
END $$;
