DO $$
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO general_ledger (
    user_id,
    amount,
    direction,
    category,
    ledger_scope,
    classification,
    description,
    source_table,
    created_at
  ) VALUES (
    '06b14430-7cdc-41c9-96a4-a8dedf8995b1',
    2552949162,
    'cash_in',
    'partner_funding',
    'platform',
    'legacy_real',
    'Pre-ledger partner capital: 435 portfolios funded from supporter wallets before the ledger system was operational. Total verified from investor_portfolios (wallet-funded, active/matured/completed).',
    'investor_portfolios',
    now()
  );
END $$;