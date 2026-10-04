DO $$
DECLARE
  v_agent_id uuid := '04ef6aad-ade8-4dbc-ae3f-09669a836952';
  v_dep1_id uuid := '300f89f8-5516-4278-80f6-0902e0134095';
  v_dep2_id uuid := '3cf3bf0d-fbbc-4312-92df-bbabf8f3745a';
  v_total numeric := 142400;
  v_now timestamptz := now();
BEGIN
  PERFORM create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent_id::text,
        'amount', 105000,
        'direction', 'cash_out',
        'category', 'agent_float_deposit',
        'ledger_scope', 'wallet',
        'source_table', 'deposit_requests',
        'source_id', v_dep1_id::text,
        'reference_id', 'TID145134041858',
        'description', 'Backfill: sweep to operational float (Airtel)',
        'currency', 'UGX',
        'transaction_date', v_now
      ),
      jsonb_build_object(
        'user_id', v_agent_id::text,
        'amount', 105000,
        'direction', 'cash_in',
        'category', 'agent_float_deposit',
        'ledger_scope', 'platform',
        'source_table', 'deposit_requests',
        'source_id', v_dep1_id::text,
        'description', 'Backfill: operational float credited to agent landlord float',
        'currency', 'UGX',
        'transaction_date', v_now
      )
    )
  );

  PERFORM create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent_id::text,
        'amount', 37400,
        'direction', 'cash_out',
        'category', 'agent_float_deposit',
        'ledger_scope', 'wallet',
        'source_table', 'deposit_requests',
        'source_id', v_dep2_id::text,
        'reference_id', 'TID145495136173',
        'description', 'Backfill: sweep to operational float (Airtel)',
        'currency', 'UGX',
        'transaction_date', v_now
      ),
      jsonb_build_object(
        'user_id', v_agent_id::text,
        'amount', 37400,
        'direction', 'cash_in',
        'category', 'agent_float_deposit',
        'ledger_scope', 'platform',
        'source_table', 'deposit_requests',
        'source_id', v_dep2_id::text,
        'description', 'Backfill: operational float credited to agent landlord float',
        'currency', 'UGX',
        'transaction_date', v_now
      )
    )
  );

  UPDATE agent_landlord_float
  SET balance = balance + v_total,
      total_funded = total_funded + v_total,
      updated_at = v_now
  WHERE agent_id = v_agent_id;

  INSERT INTO agent_float_funding (agent_id, amount, status, bank_reference, bank_name, notes)
  VALUES
    (v_agent_id, 105000, 'approved', 'TID145134041858', 'Airtel',
     'Backfill: self-deposit operational float (20 Apr) - corrected routing'),
    (v_agent_id, 37400, 'approved', 'TID145495136173', 'Airtel',
     'Backfill: self-deposit operational float (21 Apr) - corrected routing');
END $$;