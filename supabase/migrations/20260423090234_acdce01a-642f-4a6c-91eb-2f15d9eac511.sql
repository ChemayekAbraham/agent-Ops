DO $$
DECLARE
  v_result text;
BEGIN
  v_result := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c',
        'amount', 35000000,
        'direction', 'cash_in',
        'category', 'system_balance_correction',
        'ledger_scope', 'wallet',
        'description', 'Opening equity back-fill — pre-ledger wallet activity (LUKODDA JOSEPH)',
        'currency', 'UGX',
        'source_table', 'admin_corrections',
        'transaction_date', now()
      ),
      jsonb_build_object(
        'amount', 35000000,
        'direction', 'cash_out',
        'category', 'system_balance_correction',
        'ledger_scope', 'platform',
        'description', 'Opening equity back-fill — pre-ledger wallet activity (LUKODDA JOSEPH)',
        'currency', 'UGX',
        'source_table', 'admin_corrections',
        'transaction_date', now()
      )
    )
  )::text;
  RAISE NOTICE 'Created txn group: %', v_result;
END $$;