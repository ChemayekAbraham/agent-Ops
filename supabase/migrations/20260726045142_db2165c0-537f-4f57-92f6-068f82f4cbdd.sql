
DO $$
DECLARE
  v_user uuid := 'c0c1180a-fb3a-43cd-8d56-2d42df377317';
  v_src uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  INSERT INTO public.general_ledger
    (user_id, amount, direction, category, ledger_scope, wallet_bucket, recipient_type,
     source_table, source_id, description, classification, transaction_date, currency)
  VALUES
    (v_user, 10000, 'cash_in', 'agent_float_deposit', 'wallet', 'float', 'operational_wallet',
     'admin_correction', v_src,
     'Manual recovery TID 152499138285 airtel float (Williams Kyambadde) — IFTTT email missing',
     'admin_correction', now(), 'UGX'),
    (NULL, 10000, 'cash_out', 'system_balance_correction', 'platform', NULL, NULL,
     'admin_correction', v_src,
     'Offset for TID 152499138285 recovery (Williams Kyambadde)',
     'admin_correction', now(), 'UGX');
END $$;
