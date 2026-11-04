-- Reverses 20261028160000_record_immaculate_float_returns_other_numbers.sql: gives her desk the UGX 10,000,000 back (two reversing entries, the
-- ledger is append-only), puts the first receipt's return row back on the second profile as "no_float", and removes the second receipt's row.

DO $$
DECLARE
  c_agent constant uuid := '1a88b1b8-6601-477b-b119-8e18d5dc9ebd';
  c_desk  constant uuid := '6078d940-3c87-425b-8b36-f6462bb2e406';
  v_tid text;
  v_ret record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('merchant_float_return:' || c_agent::text));

  FOREACH v_tid IN ARRAY ARRAY['TID160005141382', 'TID160005769008'] LOOP
    SELECT * INTO v_ret FROM merchant_float_returns WHERE transaction_id = v_tid AND match_method = 'manual_other_number';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Receipt % was not booked by that migration. Nothing was changed.', v_tid;
    END IF;

    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', c_agent, 'amount', 5000000, 'direction', 'cash_in',
          'category', 'merchant_float_correction_writedown', 'ledger_scope', 'wallet', 'wallet_bucket', 'float',
          'recipient_type', 'operational_wallet', 'classification', 'production', 'solvency_bypass_reason', 'other_with_note',
          'source_table', 'merchant_float_returns', 'source_id', v_ret.id, 'reference_id', v_tid || '-reversal',
          'description', 'Reversal of manual float return, TID ' || v_tid, 'currency', 'UGX', 'transaction_date', now()),
        jsonb_build_object(
          'amount', 5000000, 'direction', 'cash_out',
          'category', 'merchant_float_correction_writedown', 'ledger_scope', 'platform', 'classification', 'production',
          'source_table', 'merchant_float_returns', 'source_id', v_ret.id, 'reference_id', v_tid || '-reversal',
          'description', 'Platform: reversal of manual float return, TID ' || v_tid, 'currency', 'UGX', 'transaction_date', now())
      ),
      idempotency_key := 'merchant_float_return_reversal:' || v_ret.gmail_transaction_id::text,
      skip_balance_check := true
    );

    IF v_tid = 'TID160005141382' THEN
      UPDATE merchant_float_returns
         SET agent_id = '27d5a08b-5fee-452e-bc9a-bc8064f96ae3', desk_id = '3c664192-cd2b-4c83-94d1-cf3f3df8338f',
             amount_written_down = 0, excess_amount = 5000000, float_before = 0, float_after = 0,
             status = 'no_float', match_method = 'phone', ledger_group_id = NULL
       WHERE id = v_ret.id;
      UPDATE ledger_reconciled_tids SET user_id = '27d5a08b-5fee-452e-bc9a-bc8064f96ae3',
             notes = 'Merchant desk float return, recorded automatically from the provider receipt'
       WHERE tid_normalized = '160005141382';
    ELSE
      DELETE FROM ledger_reconciled_tids WHERE tid_normalized = '160005769008';
      DELETE FROM merchant_float_returns WHERE id = v_ret.id;
    END IF;
  END LOOP;

  PERFORM public.sync_merchant_desk_float_cache(c_desk, 'rollback of manual float returns from other numbers');
END $$;
