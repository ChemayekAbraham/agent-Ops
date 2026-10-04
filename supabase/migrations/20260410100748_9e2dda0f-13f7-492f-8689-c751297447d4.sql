CREATE OR REPLACE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id uuid;
  v_entry jsonb;
  v_total_in numeric := 0;
  v_total_out numeric := 0;
  v_entry_count int := 0;
  v_total_amount numeric := 0;
  v_user_balance numeric;
  v_lock_key bigint;
BEGIN
  -- ═══ SAFETY GUARD: entries must be a JSON array ═══
  IF entries IS NULL OR jsonb_typeof(entries) <> 'array' THEN
    RAISE EXCEPTION 'entries must be a JSON array, got: %', COALESCE(jsonb_typeof(entries), 'NULL');
  END IF;

  -- Set session flag for the ledger write guard trigger
  PERFORM set_config('ledger.authorized', 'true', true);

  -- Deterministic idempotency lock
  IF idempotency_key IS NOT NULL AND idempotency_key <> '' THEN
    v_lock_key := abs(hashtext(idempotency_key));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT transaction_group_id INTO v_group_id
    FROM general_ledger
    WHERE general_ledger.idempotency_key = create_ledger_transaction.idempotency_key
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_group_id IS NOT NULL THEN
      RETURN v_group_id;
    END IF;
  END IF;

  v_group_id := gen_random_uuid();

  -- Validate balance and compute totals
  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    IF (v_entry->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'All amounts must be positive, got: %', v_entry->>'amount';
    END IF;

    IF v_entry->>'direction' = 'cash_in' THEN
      v_total_in := v_total_in + (v_entry->>'amount')::numeric;
    ELSIF v_entry->>'direction' = 'cash_out' THEN
      v_total_out := v_total_out + (v_entry->>'amount')::numeric;

      -- Balance guard for wallet-scope cash_out
      IF COALESCE(v_entry->>'ledger_scope', 'wallet') = 'wallet' THEN
        SELECT COALESCE(SUM(
          CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END
        ), 0) INTO v_user_balance
        FROM general_ledger
        WHERE user_id = (v_entry->>'user_id')::uuid
          AND ledger_scope = 'wallet';

        IF v_user_balance < (v_entry->>'amount')::numeric THEN
          RAISE EXCEPTION 'Insufficient ledger balance for user %. Available: %, Required: %',
            v_entry->>'user_id', v_user_balance, v_entry->>'amount';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in or cash_out', v_entry->>'direction';
    END IF;

    v_entry_count := v_entry_count + 1;
    v_total_amount := v_total_amount + (v_entry->>'amount')::numeric;
  END LOOP;

  -- Double-entry balance check
  IF v_total_in <> v_total_out THEN
    RAISE EXCEPTION 'Transaction not balanced. Total cash_in (%) <> total cash_out (%)', v_total_in, v_total_out;
  END IF;

  -- Insert all entries
  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    INSERT INTO general_ledger (
      user_id, ledger_scope, direction, category, amount, currency,
      description, source_table, source_id, transaction_group_id,
      idempotency_key, transaction_date
    ) VALUES (
      (v_entry->>'user_id')::uuid,
      COALESCE(v_entry->>'ledger_scope', 'wallet'),
      v_entry->>'direction',
      v_entry->>'category',
      (v_entry->>'amount')::numeric,
      COALESCE(v_entry->>'currency', 'UGX'),
      v_entry->>'description',
      v_entry->>'source_table',
      NULLIF(v_entry->>'source_id', ''),
      v_group_id,
      create_ledger_transaction.idempotency_key,
      COALESCE((v_entry->>'transaction_date')::timestamptz, now())
    );
  END LOOP;

  -- Audit log
  INSERT INTO audit_logs (action, entity_type, entity_id, metadata)
  VALUES (
    'ledger_transaction_created',
    'general_ledger',
    v_group_id::text,
    jsonb_build_object(
      'transaction_group_id', v_group_id,
      'entry_count', v_entry_count,
      'total_amount', v_total_amount,
      'idempotency_key', idempotency_key
    )
  );

  RETURN v_group_id;
END;
$$;