DO $$
DECLARE
  v_dup uuid;
  v_amt numeric;
  v_agent uuid;
  v_landlord text;
BEGIN
  FOR v_dup IN
    SELECT transaction_group_id
    FROM public.general_ledger
    WHERE source_id = 'b6eba685-addb-4468-b780-ae5cac4de9f9'
      AND category IN ('rent_disbursement','rent_receivable_created')
      AND transaction_group_id <> 'a98801b5-c864-4daa-a409-328eac61246b'
    GROUP BY transaction_group_id
  LOOP
    SELECT amount, user_id, linked_party
      INTO v_amt, v_agent, v_landlord
    FROM public.general_ledger
    WHERE transaction_group_id = v_dup AND category = 'rent_disbursement'
    LIMIT 1;

    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'direction','cash_in',
          'amount', v_amt,
          'category','rent_disbursement',
          'ledger_scope','platform',
          'source_table','rent_requests',
          'source_id','b6eba685-addb-4468-b780-ae5cac4de9f9',
          'description','Reversal of duplicate rent float funding (group '||v_dup||') - RR b6eba685',
          'sub_category','duplicate_reversal',
          'currency','UGX',
          'user_id', v_agent,
          'linked_party', v_landlord
        ),
        jsonb_build_object(
          'direction','cash_out',
          'amount', v_amt,
          'category','rent_receivable_created',
          'ledger_scope','bridge',
          'source_table','rent_requests',
          'source_id','b6eba685-addb-4468-b780-ae5cac4de9f9',
          'description','Reversal of duplicate rent receivable (group '||v_dup||') - RR b6eba685',
          'sub_category','duplicate_reversal',
          'currency','UGX',
          'user_id', v_agent,
          'linked_party', v_landlord
        )
      ),
      idempotency_key => 'dup-funding-reversal:b6eba685:'||v_dup,
      skip_balance_check => true
    );
  END LOOP;
END $$;