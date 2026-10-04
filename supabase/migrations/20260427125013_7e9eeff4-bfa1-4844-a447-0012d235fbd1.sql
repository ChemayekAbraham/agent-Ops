
DO $$
DECLARE
  v_user uuid := '0b109aad-212a-4fd0-ab03-3d7aee9cf397';
  v_wallet uuid := '048a011c-eb12-4783-8e5e-90ca3143b000';
  v_amount numeric := 144110;
BEGIN
  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_user::text,
        'direction', 'cash_out',
        'category', 'system_balance_correction',
        'amount', v_amount,
        'currency', 'UGX',
        'ledger_scope', 'wallet',
        'description', 'Test wallet reset — SSENKAALI PIUS (test_funds swept)',
        'account', 'wallet',
        'source_table', 'wallets'
      ),
      jsonb_build_object(
        'user_id', v_user::text,
        'direction', 'cash_in',
        'category', 'system_balance_correction',
        'amount', v_amount,
        'currency', 'UGX',
        'ledger_scope', 'bridge',
        'description', 'Test wallet reset — offset to platform clearing',
        'account', 'platform_clearing',
        'source_table', 'wallets'
      )
    ),
    'test-reset-ssenkaali-' || extract(epoch from now())::text,
    true
  );

  PERFORM set_config('wallet.sync_authorized','true', true);
  UPDATE public.wallets
     SET balance = 0,
         withdrawable_balance = 0,
         float_balance = 0,
         advance_balance = 0,
         locked_balance = 0,
         updated_at = now()
   WHERE id = v_wallet;
END $$;
