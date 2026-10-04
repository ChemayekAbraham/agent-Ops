CREATE OR REPLACE FUNCTION public.create_ledger_transaction(entries JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  group_id UUID := gen_random_uuid();
  total_cash_in NUMERIC := 0;
  total_cash_out NUMERIC := 0;
  entry JSONB;
  entry_category TEXT;
  entry_amount NUMERIC;
  has_roi_expense BOOLEAN := FALSE;
  has_roi_credit BOOLEAN := FALSE;
  platform_cash NUMERIC;
  roi_total NUMERIC := 0;
  allowed_categories TEXT[] := ARRAY[
    'access_fee_collected',
    'registration_fee_collected',
    'wallet_deposit',
    'tenant_repayment',
    'agent_repayment',
    'partner_funding',
    'share_capital',
    'rent_disbursement',
    'rent_receivable_created',
    'rent_principal_collected',
    'roi_expense',
    'roi_wallet_credit',
    'roi_reinvestment',
    'agent_commission_earned',
    'agent_commission_withdrawal',
    'agent_commission_used_for_rent',
    'wallet_withdrawal',
    'wallet_transfer',
    'system_balance_correction',
    'orphan_reassignment',
    'orphan_reversal',
    'agent_float_deposit',
    'agent_float_used_for_rent'
  ];
BEGIN
  -- ============================================
  -- PASS 1: Validate all entries
  -- ============================================
  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    entry_category := COALESCE(entry->>'category', 'general');
    entry_amount := (entry->>'amount')::NUMERIC;

    -- Direction validation
    IF entry->>'direction' NOT IN ('cash_in', 'cash_out') THEN
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in or cash_out', entry->>'direction';
    END IF;

    -- Amount guard (HARD)
    IF entry_amount IS NULL OR entry_amount <= 0 THEN
      RAISE EXCEPTION 'Invalid amount: %. Must be greater than 0', entry_amount;
    END IF;

    -- Category allowlist (SOFT — notice only)
    IF NOT (entry_category = ANY(allowed_categories)) THEN
      RAISE NOTICE 'LEGACY CATEGORY USED: % — not in locked allowlist', entry_category;
    END IF;

    -- Track ROI flow entries
    IF entry_category = 'roi_expense' THEN
      has_roi_expense := TRUE;
      roi_total := roi_total + entry_amount;
    END IF;
    IF entry_category IN ('roi_wallet_credit', 'roi_reinvestment') THEN
      has_roi_credit := TRUE;
    END IF;

    -- Accumulate balance check
    IF entry->>'direction' = 'cash_in' THEN
      total_cash_in := total_cash_in + entry_amount;
    ELSE
      total_cash_out := total_cash_out + entry_amount;
    END IF;
  END LOOP;

  -- ============================================
  -- PASS 2: Flow-level rules
  -- ============================================

  -- Balance check (HARD)
  IF total_cash_in != total_cash_out THEN
    RAISE EXCEPTION 'UNBALANCED TRANSACTION: cash_in=% cash_out=%', total_cash_in, total_cash_out;
  END IF;

  IF total_cash_in = 0 THEN
    RAISE EXCEPTION 'EMPTY TRANSACTION: no amounts provided';
  END IF;

  -- ROI flow rule (HARD) — roi_expense MUST have matching credit
  IF has_roi_expense AND NOT has_roi_credit THEN
    RAISE EXCEPTION 'ROI FLOW VIOLATION: roi_expense requires roi_wallet_credit or roi_reinvestment in the same transaction group';
  END IF;

  -- ROI liquidity guard (SOFT — notice only)
  IF has_roi_expense THEN
    SELECT COALESCE(SUM(
      CASE WHEN direction = 'cash_in' THEN amount
           WHEN direction = 'cash_out' THEN -amount
           ELSE 0 END
    ), 0) INTO platform_cash
    FROM public.general_ledger
    WHERE ledger_scope = 'platform';

    IF platform_cash < roi_total THEN
      RAISE NOTICE 'ROI LIQUIDITY WARNING: platform_cash=% but roi_total=%. Proceeding in soft mode.', platform_cash, roi_total;
    END IF;
  END IF;

  -- ============================================
  -- PASS 3: Insert entries
  -- ============================================
  -- Set bypass flag so the safety trigger doesn't double-check
  PERFORM set_config('app.bypass_category_check', 'true', true);

  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    INSERT INTO public.general_ledger (
      transaction_group_id,
      user_id,
      ledger_scope,
      direction,
      amount,
      category,
      description,
      reference_id,
      source_table,
      created_at
    ) VALUES (
      group_id,
      NULLIF(entry->>'user_id', '')::UUID,
      COALESCE(entry->>'ledger_scope', 'wallet'),
      entry->>'direction',
      (entry->>'amount')::NUMERIC,
      COALESCE(entry->>'category', 'general'),
      entry->>'description',
      entry->>'reference_id',
      COALESCE(entry->>'source_table', 'system'),
      NOW()
    );
  END LOOP;

  RETURN group_id;
END;
$$;