DO $$
DECLARE
  v_user uuid := '475c6ccb-166c-41cd-b2a8-386c99777138';
  v_wallet_id uuid;
BEGIN
  SELECT id INTO v_wallet_id FROM public.wallets_physical WHERE user_id = v_user;

  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'amount', 1680000,
        'direction','cash_in',
        'category','wallet_deposit',
        'user_id', v_user,
        'ledger_scope','wallet',
        'classification','production',
        'wallet_id', v_wallet_id,
        'recipient_type','user',
        'wallet_bucket','withdrawable',
        'account','user_wallet',
        'source_table','admin_correction',
        'description','CFO restoration – restore original 1.68M credit consumed by system drift correction (Keith Asea)',
        'reference_id','FIX-KEITH-RESTORE-168'
      ),
      jsonb_build_object(
        'amount', 1680000,
        'direction','cash_out',
        'category','wallet_deposit',
        'ledger_scope','platform',
        'classification','production',
        'account','platform_balance',
        'source_table','admin_correction',
        'description','CFO restoration – restore original 1.68M credit consumed by system drift correction (Keith Asea)',
        'reference_id','FIX-KEITH-RESTORE-168'
      )
    ),
    'FIX-KEITH-RESTORE-168-v1',
    true
  );

  PERFORM public.rebuild_wallet_projection(v_user);
END $$;