
CREATE OR REPLACE FUNCTION public.create_ledger_transaction(
  entries JSONB,
  idempotency_key TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  entry JSONB;
  group_id UUID;
  total_in NUMERIC := 0;
  total_out NUMERIC := 0;
  entry_direction TEXT;
  entry_amount NUMERIC;
  entry_scope TEXT;
  wallet_user TEXT;
  wallet_balance NUMERIC;
  locked_categories TEXT[] := ARRAY[
    'rent_principal_collected',
    'service_fee_revenue', 
    'roi_payout',
    'wallet_topup',
    'wallet_withdrawal',
    'deposit_refund',
    'commission_payout'
  ];
  strict_mode BOOLEAN := false;
  entry_category TEXT;
BEGIN
  -- Advisory lock for idempotency: serialize concurrent requests with the same key
  IF idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(idempotency_key));
    
    SELECT transaction_group_id INTO group_id
    FROM public.general_ledger
    WHERE reference_id = idempotency_key
    ORDER BY created_at ASC
    LIMIT 1;
    
    IF group_id IS NOT NULL THEN
      RETURN group_id;
    END IF;
  END IF;

  group_id := gen_random_uuid();

  -- Validate entries
  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    entry_direction := LOWER(COALESCE(entry->>'direction', ''));
    entry_amount := COALESCE((entry->>'amount')::NUMERIC, 0);
    entry_scope := COALESCE(entry->>'ledger_scope', 'platform');
    entry_category := COALESCE(entry->>'category', '');

    -- Normalize direction
    IF entry_direction IN ('credit', 'in') THEN
      entry_direction := 'cash_in';
    ELSIF entry_direction IN ('debit', 'out') THEN
      entry_direction := 'cash_out';
    END IF;

    -- Reject invalid amounts
    IF entry_amount <= 0 THEN
      RAISE EXCEPTION 'All entry amounts must be positive. Got: %', entry_amount;
    END IF;

    -- Category governance
    IF strict_mode AND entry_category != '' AND NOT (entry_category = ANY(locked_categories)) THEN
      RAISE EXCEPTION 'Category "%" is not in the approved list', entry_category;
    END IF;

    -- Sum for balance check
    IF entry_direction = 'cash_in' THEN
      total_in := total_in + entry_amount;
    ELSIF entry_direction = 'cash_out' THEN
      total_out := total_out + entry_amount;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in, cash_out, credit, debit, in, or out.', entry_direction;
    END IF;

    -- Wallet scope negative balance guard
    IF entry_scope = 'wallet' AND entry_direction = 'cash_out' THEN
      wallet_user := entry->>'user_id';
      IF wallet_user IS NOT NULL THEN
        SELECT COALESCE(SUM(cash_in) - SUM(cash_out), 0) INTO wallet_balance
        FROM public.general_ledger
        WHERE user_id = wallet_user::UUID AND ledger_scope = 'wallet';

        IF wallet_balance < entry_amount THEN
          RAISE EXCEPTION 'Insufficient wallet balance. Available: %, Requested: %', wallet_balance, entry_amount;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Enforce double-entry balance
  IF total_in != total_out THEN
    RAISE EXCEPTION 'Unbalanced transaction: total_in (%) != total_out (%)', total_in, total_out;
  END IF;

  -- Insert all entries
  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    entry_direction := LOWER(COALESCE(entry->>'direction', ''));
    IF entry_direction IN ('credit', 'in') THEN
      entry_direction := 'cash_in';
    ELSIF entry_direction IN ('debit', 'out') THEN
      entry_direction := 'cash_out';
    END IF;

    INSERT INTO public.general_ledger (
      user_id,
      direction,
      cash_in,
      cash_out,
      category,
      description,
      source_table,
      source_id,
      reference_id,
      ledger_scope,
      transaction_group_id,
      created_at
    ) VALUES (
      (entry->>'user_id')::UUID,
      entry_direction,
      CASE WHEN entry_direction = 'cash_in' THEN (entry->>'amount')::NUMERIC ELSE 0 END,
      CASE WHEN entry_direction = 'cash_out' THEN (entry->>'amount')::NUMERIC ELSE 0 END,
      COALESCE(entry->>'category', 'uncategorized'),
      COALESCE(entry->>'description', ''),
      COALESCE(entry->>'source_table', ''),
      COALESCE(entry->>'source_id', ''),
      COALESCE(idempotency_key, entry->>'reference_id', ''),
      COALESCE(entry->>'ledger_scope', 'platform'),
      group_id,
      NOW()
    );
  END LOOP;

  -- Audit log
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    auth.uid()::TEXT,
    'ledger_transaction',
    'general_ledger',
    group_id::TEXT,
    jsonb_build_object('entry_count', jsonb_array_length(entries), 'total', total_in, 'idempotency_key', idempotency_key)
  );

  RETURN group_id;
END;
$$;
