DO $$
DECLARE
  v_group uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('wallet.sync_authorized','true', true);
  PERFORM set_config('ledger.authorized','true', true);
  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id','ebf0897b-dfdf-4403-ad5c-1c988c72e67c',
        'amount',14000,
        'direction','cash_in',
        'ledger_scope','wallet',
        'wallet_bucket','float',
        'category','agent_float_deposit',
        'classification','admin_correction',
        'recipient_type','operational_wallet',
        'description','Manual recovery TID 152491206826 airtel float (Watsala Enock) — depositor tagged 10,000 by mistake; SMS confirms UGX 24,000. Crediting missing 14,000.',
        'transaction_group_id', v_group
      ),
      jsonb_build_object(
        'amount',14000,
        'direction','cash_out',
        'ledger_scope','platform',
        'category','system_balance_correction',
        'classification','admin_correction',
        'description','Offset for TID 152491206826 recovery (Watsala Enock) — 14,000 delta from mistagged deposit',
        'transaction_group_id', v_group
      )
    ),
    'watsala-152491206826-14k-recovery',
    true
  );
END $$;