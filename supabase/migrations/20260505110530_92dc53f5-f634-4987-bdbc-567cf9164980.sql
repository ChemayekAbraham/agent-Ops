SELECT public.create_ledger_transaction(
  jsonb_build_array(
    jsonb_build_object(
      'user_id','ae194750-4827-47e8-839e-5e772565138b',
      'amount',151927531,
      'direction','cash_in',
      'category','wallet_deposit',
      'ledger_scope','wallet',
      'classification','admin_correction',
      'source_table','manual_reconciliation',
      'reference_id','SHIFT-CAROLYNE-152M-002',
      'description','Shift float→withdrawable for CFO deduction (no net impact)',
      'currency','UGX'
    ),
    jsonb_build_object(
      'user_id','ae194750-4827-47e8-839e-5e772565138b',
      'amount',151927531,
      'direction','cash_out',
      'category','agent_float_settlement',
      'ledger_scope','wallet',
      'classification','admin_correction',
      'source_table','manual_reconciliation',
      'reference_id','SHIFT-CAROLYNE-152M-002',
      'description','Drain float bucket portion mirrored above (no net impact)',
      'currency','UGX'
    )
  ),
  'shift-carolyne-152m-002',
  true
);
SELECT withdrawable_balance, float_balance, balance, get_user_available_balance('ae194750-4827-47e8-839e-5e772565138b') AS strict
FROM wallets WHERE user_id='ae194750-4827-47e8-839e-5e772565138b';