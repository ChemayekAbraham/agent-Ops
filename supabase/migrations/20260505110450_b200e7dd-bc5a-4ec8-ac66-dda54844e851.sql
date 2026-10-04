DO $$
DECLARE
  v_user uuid := 'ae194750-4827-47e8-839e-5e772565138b';
  v_cached numeric;
  v_strict numeric;
  v_delta  numeric;
BEGIN
  SELECT withdrawable_balance INTO v_cached FROM public.wallets WHERE user_id = v_user;
  v_strict := public.get_user_available_balance(v_user);
  v_delta  := v_strict - COALESCE(v_cached,0);
  IF v_delta <= 0 THEN
    RAISE NOTICE 'No lift needed (cached=% strict=%)', v_cached, v_strict;
    RETURN;
  END IF;

  PERFORM public.create_ledger_transaction(
    '[]'::jsonb || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_user,
        'amount', v_delta,
        'direction', 'cash_in',
        'category', 'system_balance_correction',
        'ledger_scope', 'wallet',
        'classification','admin_correction',
        'source_table','manual_reconciliation',
        'reference_id','LIFT-CAROLYNE-152M-001',
        'description','Lift cached withdrawable up to strict ledger so CFO deduction can proceed (no strict-net impact)',
        'currency','UGX'
      ),
      jsonb_build_object(
        'user_id', NULL,
        'amount', v_delta,
        'direction','cash_out',
        'category','system_balance_correction',
        'ledger_scope','platform',
        'classification','admin_correction',
        'source_table','manual_reconciliation',
        'reference_id','LIFT-CAROLYNE-152M-001',
        'description','Platform offset for cache lift on user ' || v_user::text,
        'currency','UGX'
      )
    ),
    'lift-carolyne-152m-001',
    true
  );
END $$;

SELECT withdrawable_balance, balance, get_user_available_balance('ae194750-4827-47e8-839e-5e772565138b') AS strict
FROM public.wallets WHERE user_id='ae194750-4827-47e8-839e-5e772565138b';