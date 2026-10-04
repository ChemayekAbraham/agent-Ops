
CREATE OR REPLACE FUNCTION public.create_ledger_transaction(entries JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  entry JSONB;
  group_id UUID := gen_random_uuid();
  total_in NUMERIC := 0;
  total_out NUMERIC := 0;
  v_category TEXT;
  v_amount NUMERIC;
  locked_categories TEXT[] := ARRAY[
    'wallet_deposit','wallet_withdrawal','wallet_deduction','rent_disbursement','rent_receivable_created',
    'tenant_repayment','rent_principal_collected','access_fee_collected','registration_fee_collected',
    'roi_expense','roi_wallet_credit','roi_reinvestment',
    'agent_commission_earned','agent_commission_withdrawal','agent_commission_used_for_rent',
    'agent_repayment','agent_float_used_for_rent','agent_float_deposit',
    'partner_funding','share_capital','wallet_transfer','system_balance_correction',
    'orphan_reassignment','orphan_reversal',
    'test_funds_cleanup','referral_bonus','reward_payout'
  ];
  strict_on BOOLEAN := FALSE;
  has_roi_expense BOOLEAN := FALSE;
  has_roi_credit BOOLEAN := FALSE;
  v_wallet_bal NUMERIC;
BEGIN
  SELECT enabled INTO strict_on FROM treasury_controls WHERE control_key = 'strict_mode';

  -- PASS 1: Validate all entries
  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    v_amount := (entry->>'amount')::NUMERIC;
    v_category := entry->>'category';

    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Amount must be positive, got: %', v_amount;
    END IF;

    -- Direction normalization: map legacy directions
    IF entry->>'direction' IN ('credit', 'in') THEN
      entry := jsonb_set(entry, '{direction}', '"cash_in"');
    ELSIF entry->>'direction' IN ('debit', 'out') THEN
      entry := jsonb_set(entry, '{direction}', '"cash_out"');
    END IF;

    IF entry->>'direction' = 'cash_in' THEN
      total_in := total_in + v_amount;
    ELSIF entry->>'direction' = 'cash_out' THEN
      total_out := total_out + v_amount;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %', entry->>'direction';
    END IF;

    IF v_category IS NOT NULL AND NOT (v_category = ANY(locked_categories)) THEN
      IF strict_on THEN
        RAISE EXCEPTION 'Blocked category: %', v_category;
      ELSE
        RAISE NOTICE 'LEGACY CATEGORY USED: %', v_category;
      END IF;
    END IF;

    IF v_category = 'roi_expense' THEN has_roi_expense := TRUE; END IF;
    IF v_category IN ('roi_wallet_credit', 'roi_reinvestment') THEN has_roi_credit := TRUE; END IF;
  END LOOP;

  IF total_in != total_out THEN
    RAISE EXCEPTION 'Unbalanced transaction: cash_in=% cash_out=%', total_in, total_out;
  END IF;

  IF has_roi_expense AND NOT has_roi_credit THEN
    RAISE EXCEPTION 'ROI expense without credit or reinvestment entry';
  END IF;

  PERFORM set_config('ledger.bypass_trigger', 'true', true);

  -- PASS 2: Insert entries with wallet guard
  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    -- Re-apply direction normalization for the insert pass
    IF entry->>'direction' IN ('credit', 'in') THEN
      entry := jsonb_set(entry, '{direction}', '"cash_in"');
    ELSIF entry->>'direction' IN ('debit', 'out') THEN
      entry := jsonb_set(entry, '{direction}', '"cash_out"');
    END IF;

    -- Wallet negative balance guard
    IF entry->>'ledger_scope' = 'wallet' AND entry->>'direction' = 'cash_out' THEN
      SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
      INTO v_wallet_bal
      FROM general_ledger
      WHERE user_id = (entry->>'user_id')::UUID AND ledger_scope = 'wallet';

      IF v_wallet_bal < (entry->>'amount')::NUMERIC THEN
        RAISE EXCEPTION 'Insufficient wallet balance for user %. Balance: %, Requested: %',
          entry->>'user_id', v_wallet_bal, entry->>'amount';
      END IF;
    END IF;

    INSERT INTO general_ledger (
      transaction_group_id, user_id, ledger_scope, direction, amount, category,
      description, reference_id, source_table, source_id, linked_party,
      transaction_date, currency, account, created_at
    )
    VALUES (
      group_id,
      NULLIF(entry->>'user_id','')::UUID,
      entry->>'ledger_scope',
      entry->>'direction',
      (entry->>'amount')::NUMERIC,
      entry->>'category',
      entry->>'description',
      entry->>'reference_id',
      entry->>'source_table',
      entry->>'source_id',
      entry->>'linked_party',
      COALESCE((entry->>'transaction_date')::TIMESTAMPTZ, NOW()),
      COALESCE(entry->>'currency', 'UGX'),
      entry->>'account',
      NOW()
    );
  END LOOP;

  -- Audit log
  INSERT INTO audit_logs (user_id, action_type, metadata, created_at)
  VALUES (NULL, 'ledger_transaction', jsonb_build_object(
    'group_id', group_id,
    'entry_count', jsonb_array_length(entries),
    'total_amount', total_in
  ), NOW());

  RETURN group_id;
END;
$$;
