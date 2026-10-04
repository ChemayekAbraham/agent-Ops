SELECT public.create_ledger_transaction(
  entries := to_jsonb(ARRAY[
    jsonb_build_object(
      'user_id', 'bd266fc7-1066-468a-8beb-347430d9d9b6',
      'amount', 6000,
      'direction', 'cash_out',
      'category', 'wallet_withdrawal',
      'ledger_scope', 'wallet',
      'description', 'Backfill: withdrawal approved 2026-04-10 (rogue trigger drift correction)',
      'currency', 'UGX',
      'source_table', 'withdrawal_requests',
      'source_id', '8b437145-e259-40b0-b94c-5421796374a7',
      'transaction_date', '2026-04-10T07:42:18.295Z'
    ),
    jsonb_build_object(
      'amount', 6000,
      'direction', 'cash_in',
      'category', 'wallet_withdrawal',
      'ledger_scope', 'platform',
      'description', 'Backfill: platform records withdrawal payout (rogue trigger drift correction)',
      'currency', 'UGX',
      'source_table', 'withdrawal_requests',
      'source_id', '8b437145-e259-40b0-b94c-5421796374a7',
      'transaction_date', '2026-04-10T07:42:18.295Z'
    )
  ])
);