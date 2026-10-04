DO $$
DECLARE v_agent uuid := '0b109aad-212a-4fd0-ab03-3d7aee9cf397';
        v_float numeric;
BEGIN
  -- 1. Remove the simulated test payout + its float consume/telecom legs stay as ledger history,
  --    so we neutralise the whole position with one correction below.
  DELETE FROM public.withdrawal_requests
   WHERE user_id = v_agent
     AND reason = '[SMOKE TEST] merchant float payout reconciliation';

  DELETE FROM public.deposit_requests WHERE transaction_id = 'SMOKEFLOAT140826A';
  DELETE FROM public.gmail_transactions WHERE gmail_message_id = 'smoke-float-20260814-001';

  -- 2. Zero the float bucket back out
  SELECT float_balance INTO v_float FROM public.wallets WHERE user_id = v_agent;

  IF v_float IS NOT NULL AND v_float <> 0 THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id',v_agent,'ledger_scope','wallet','wallet_bucket','float',
          'direction', CASE WHEN v_float > 0 THEN 'cash_out' ELSE 'cash_in' END,
          'category','system_balance_correction','recipient_type','operational_wallet',
          'amount', abs(v_float), 'classification','admin_correction',
          'solvency_bypass_reason','admin_correction_seed',
          'reference_id','smoke-float-revert-20260814',
          'description','[SMOKE REVERT] Reverse smoke test float to zero'),
        jsonb_build_object('ledger_scope','platform',
          'direction', CASE WHEN v_float > 0 THEN 'cash_in' ELSE 'cash_out' END,
          'category','system_balance_correction','amount', abs(v_float),
          'classification','admin_correction','solvency_bypass_reason','admin_correction_seed',
          'reference_id','smoke-float-revert-20260814',
          'description','[SMOKE REVERT] Platform side of smoke test reversal')
      ), 'smoke-float-revert-20260814-001', true);
  END IF;
END $$;