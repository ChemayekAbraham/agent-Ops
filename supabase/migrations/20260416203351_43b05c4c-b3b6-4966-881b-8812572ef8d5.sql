DO $$
DECLARE
  v_agent uuid := 'ae194750-4827-47e8-839e-5e772565138b';
  v_partner uuid := '1b16db51-199c-4ce8-9035-a28210d00349';
  v_portfolio uuid := '65ba4466-e726-4c67-9980-38e3ce1d0ebd';
  v_amount numeric := 5000;
  v_balance_before numeric;
  v_balance_after numeric;
  v_balance_final numeric;
BEGIN
  SELECT balance INTO v_balance_before FROM wallets WHERE user_id = v_agent;
  RAISE NOTICE 'BEFORE: agent balance = %', v_balance_before;

  -- STEP 1: simulate edge function deduction
  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent, 'amount', v_amount, 'direction', 'cash_out',
        'category', 'wallet_deduction',
        'description', 'BG TEST: top-up deduction (will be reversed)',
        'source_table', 'investor_portfolios', 'source_id', v_portfolio,
        'linked_party', 'platform'
      ),
      jsonb_build_object(
        'user_id', v_partner, 'amount', v_amount, 'direction', 'cash_in',
        'category', 'pending_portfolio_topup',
        'description', 'BG TEST: pending capital (will be reversed)',
        'source_table', 'investor_portfolios', 'source_id', v_portfolio,
        'linked_party', v_agent::text
      )
    )
  );

  SELECT balance INTO v_balance_after FROM wallets WHERE user_id = v_agent;
  RAISE NOTICE 'AFTER DEDUCTION: agent balance = % (delta = %)', v_balance_after, v_balance_after - v_balance_before;

  IF v_balance_after != v_balance_before - v_amount THEN
    RAISE EXCEPTION 'TEST FAILED: expected % but got %', v_balance_before - v_amount, v_balance_after;
  END IF;

  -- STEP 2: reverse via balanced legs (system_balance_correction is in allowlist)
  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent, 'amount', v_amount, 'direction', 'cash_in',
        'category', 'system_balance_correction',
        'description', 'BG TEST: reversal of test top-up deduction',
        'source_table', 'investor_portfolios', 'source_id', v_portfolio,
        'linked_party', 'platform'
      ),
      jsonb_build_object(
        'user_id', v_partner, 'amount', v_amount, 'direction', 'cash_out',
        'category', 'system_balance_correction',
        'description', 'BG TEST: reversal of test pending capital',
        'source_table', 'investor_portfolios', 'source_id', v_portfolio,
        'linked_party', v_agent::text
      )
    )
  );

  SELECT balance INTO v_balance_final FROM wallets WHERE user_id = v_agent;
  RAISE NOTICE 'AFTER REVERSAL: agent balance = % (delta from start = %)', v_balance_final, v_balance_final - v_balance_before;

  IF v_balance_final != v_balance_before THEN
    RAISE EXCEPTION 'REVERSAL FAILED: expected % but got %', v_balance_before, v_balance_final;
  END IF;

  RAISE NOTICE '✅ TEST PASSED: deduction worked, reversal worked, balance restored to %', v_balance_final;
END $$;