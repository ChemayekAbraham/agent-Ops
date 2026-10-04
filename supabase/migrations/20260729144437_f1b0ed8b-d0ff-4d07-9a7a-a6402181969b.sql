
DO $$
DECLARE
  v_user uuid := '80d4e203-4202-4683-9d80-8f8245b92c8f';
  v_wallet uuid;
  v_amount numeric := 12000;
  v_reason text := 'Rebucket TID 42395989396 float->withdrawable to service outstanding advance (agent policy override).';
BEGIN
  SELECT id INTO v_wallet FROM public.wallets WHERE user_id = v_user;

  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'transaction_date', now(), 'amount', v_amount, 'direction', 'cash_out',
        'category', 'system_balance_correction', 'description', v_reason,
        'user_id', v_user, 'wallet_id', v_wallet, 'account', 'user_wallet',
        'ledger_scope', 'wallet', 'classification', 'admin_correction',
        'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
        'solvency_bypass_reason', 'admin_correction_seed',
        'sub_category', 'rebucket_float_to_withdrawable'
      ),
      jsonb_build_object(
        'transaction_date', now(), 'amount', v_amount, 'direction', 'cash_in',
        'category', 'system_balance_correction', 'description', v_reason,
        'account', 'platform_holding', 'ledger_scope', 'platform',
        'classification', 'admin_correction',
        'solvency_bypass_reason', 'admin_correction_seed',
        'sub_category', 'rebucket_float_to_withdrawable'
      )
    ),
    'rebucket_tid_42395989396_leg1',
    true
  );

  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'transaction_date', now(), 'amount', v_amount, 'direction', 'cash_out',
        'category', 'system_balance_correction', 'description', v_reason,
        'account', 'platform_holding', 'ledger_scope', 'platform',
        'classification', 'admin_correction',
        'solvency_bypass_reason', 'admin_correction_seed',
        'sub_category', 'rebucket_float_to_withdrawable'
      ),
      jsonb_build_object(
        'transaction_date', now(), 'amount', v_amount, 'direction', 'cash_in',
        'category', 'system_balance_correction', 'description', v_reason,
        'user_id', v_user, 'wallet_id', v_wallet, 'account', 'user_wallet',
        'ledger_scope', 'wallet', 'classification', 'admin_correction',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'solvency_bypass_reason', 'admin_correction_seed',
        'sub_category', 'rebucket_float_to_withdrawable'
      )
    ),
    'rebucket_tid_42395989396_leg2',
    true
  );
END $$;

SELECT public.sweep_agent_advance_recovery();
