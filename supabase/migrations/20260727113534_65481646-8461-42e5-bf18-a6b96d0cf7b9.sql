DO $$
DECLARE
  v_user uuid := '475c6ccb-166c-41cd-b2a8-386c99777138';
  v_wallet_id uuid;
BEGIN
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_user;

  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object('amount',500000,'direction','cash_in','category','system_balance_correction','user_id',v_user,'ledger_scope','wallet','classification','admin_correction','wallet_id',v_wallet_id,'recipient_type','user','wallet_bucket','withdrawable','account','user_wallet','source_table','admin_correction','description','Reverse erroneous backfill funding debit for portfolio WIP2606247005 (Keith Asea double-charge fix)','reference_id','FIX-KEITH-1'),
      jsonb_build_object('amount',500000,'direction','cash_out','category','system_balance_correction','ledger_scope','platform','classification','admin_correction','account','platform_balance','source_table','admin_correction','description','Reverse erroneous backfill funding debit for portfolio WIP2606247005 (Keith Asea double-charge fix)','reference_id','FIX-KEITH-1')
    ),
    'FIX-KEITH-1-REVERSAL',
    true
  );

  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object('amount',500000,'direction','cash_in','category','system_balance_correction','user_id',v_user,'ledger_scope','wallet','classification','admin_correction','wallet_id',v_wallet_id,'recipient_type','user','wallet_bucket','withdrawable','account','user_wallet','source_table','admin_correction','description','Reverse erroneous backfill funding debit for portfolio WIP2607131944 (Keith Asea double-charge fix)','reference_id','FIX-KEITH-2'),
      jsonb_build_object('amount',500000,'direction','cash_out','category','system_balance_correction','ledger_scope','platform','classification','admin_correction','account','platform_balance','source_table','admin_correction','description','Reverse erroneous backfill funding debit for portfolio WIP2607131944 (Keith Asea double-charge fix)','reference_id','FIX-KEITH-2')
    ),
    'FIX-KEITH-2-REVERSAL',
    true
  );

  PERFORM public.admin_reseed_wallet_cache(v_user, 1680000::numeric, 1680000::numeric);
END $$;