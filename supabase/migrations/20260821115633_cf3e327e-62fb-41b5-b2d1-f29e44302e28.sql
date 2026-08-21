DO $$
DECLARE
  v_agent uuid := 'b7b11e1c-20e6-448e-b8f3-5efc72dbbe4d';
  v_advance uuid := 'fd86d9c4-e5f3-4291-9ac2-78732601de54';
  v_amount numeric := 40667;
  v_open numeric;
  v_grp uuid;
BEGIN
  -- Guard: only run once
  IF EXISTS (SELECT 1 FROM public.general_ledger
             WHERE idempotency_key = 'arrears_reversal_tainted_bonus_' || v_advance::text) THEN
    RAISE NOTICE 'already corrected';
    RETURN;
  END IF;

  SELECT outstanding_balance INTO v_open FROM public.agent_advances WHERE id = v_advance FOR UPDATE;

  -- Reverse the 28-Jul advance sweep that was funded by the erroneous
  -- rent_funded_landlord_float bonus backfill (bonus reversed, sweep never was).
  v_grp := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent::text,
        'ledger_scope', 'wallet',
        'direction', 'cash_in',
        'category', 'agent_repayment',
        'amount', v_amount,
        'recipient_type', 'user',
        'wallet_bucket', 'withdrawable',
        'classification', 'production',
        'source_table', 'agent_advances',
        'source_id', v_advance::text,
        'description', 'Reversal of 28-Jul advance recovery funded by reversed landlord-float bonus backfill'
      ),
      jsonb_build_object(
        'user_id', v_agent::text,
        'ledger_scope', 'platform',
        'direction', 'cash_out',
        'category', 'agent_repayment',
        'amount', v_amount,
        'recipient_type', 'operational_wallet',
        'classification', 'production',
        'source_table', 'agent_advances',
        'source_id', v_advance::text,
        'description', 'Reversal of 28-Jul advance recovery funded by reversed landlord-float bonus backfill'
      )
    ),
    'arrears_reversal_tainted_bonus_' || v_advance::text,
    true
  );

  -- Restore the advance balance the tainted sweep had wrongly reduced
  UPDATE public.agent_advances
     SET outstanding_balance = outstanding_balance + v_amount,
         arrears_balance = arrears_balance + v_amount,
         updated_at = now()
   WHERE id = v_advance;

  INSERT INTO public.agent_advance_ledger (
    advance_id, date, opening_balance, interest_accrued, amount_deducted,
    closing_balance, deduction_status, recovery_source
  ) VALUES (
    v_advance, current_date, v_open, 0, -v_amount, v_open + v_amount,
    'none', 'correction_reversal'
  );

  PERFORM public.refresh_wallet_projection_for(v_agent);

  INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
  VALUES (
    'advance_recovery_reversed', 'agent_advances', v_advance,
    'Reversed UGX 40,667 of 28-Jul advance recovery that was swept from an erroneous landlord-float bonus backfill which was itself reversed minutes later, leaving the agent wallet permanently negative and silently absorbing all commissions earned since 2 Aug.',
    jsonb_build_object('agent_id', v_agent, 'amount', v_amount, 'transaction_group_id', v_grp)
  );
END $$;