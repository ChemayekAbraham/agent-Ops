-- Records two UGX 5,000,000 float returns that IMMACULATE NAMULINDWA's merchant desk (1a88b1b8-6601-477b-b119-8e18d5dc9ebd) sent to the
-- company on 28 Oct 2026 from OTHER phone numbers, so her float is cut by UGX 10,000,000.
--
--   13:40  Airtel  UGX 5,000,000  from 741003567  TID160005141382
--   13:48  Airtel  UGX 5,000,000  from 752383262  TID160005769008
--
-- WHY THEY WERE MISSED: the automatic float return matches the sender's phone number to a desk.
--   * 741003567 is the number of her SECOND profile (NAMULINDWA IMMECULATE, 27d5a08b-5fee-452e-bc9a-bc8064f96ae3, also an active desk with 0
--     float). The automatic job booked the receipt to that desk as "no_float" with 5,000,000 excess and wrote nothing down.
--   * 752383262 matches no profile, so nothing was booked at all.
-- Management confirmed both were sent by her to the merchant phone from another number. The MTN return at 14:03 (UGX 5,000,000, TID 44604482512)
-- was matched correctly and is not touched.
--
-- WHAT THIS DOES: books both exactly as the automatic job books a return (float cut on her desk wallet, matching platform entry, desk float
-- cache re-synced, TID marked used so it can never be credited as a deposit). The first receipt's existing "no_float" return row is moved to her real
-- desk; the second gets a new row. Stops and writes nothing unless her float falls by exactly UGX 10,000,000.
-- NOT TOUCHED: the earlier days' "no_float" rows on the second profile (19 to 27 Oct); those need their own check.
-- Roll back with 20261028160000_record_immaculate_float_returns_other_numbers.rollback.sql.

DO $$
DECLARE
  c_agent  constant uuid := '1a88b1b8-6601-477b-b119-8e18d5dc9ebd';
  c_desk   constant uuid := '6078d940-3c87-425b-8b36-f6462bb2e406';
  v_float_before numeric;
  v_float_after  numeric;
  v_tid  text;
  v_gm   record;
  v_ret  uuid;
  v_group uuid;
  v_sync jsonb;
  v_norm text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('merchant_float_return:' || c_agent::text));

  IF NOT EXISTS (SELECT 1 FROM cashout_agents WHERE id = c_desk AND agent_id = c_agent AND is_active IS TRUE) THEN
    RAISE EXCEPTION 'Desk % is not her active merchant desk. Nothing was written.', c_desk;
  END IF;

  SELECT coalesce(float_balance, 0) INTO v_float_before FROM wallets WHERE user_id = c_agent;
  IF v_float_before < 10000000 THEN
    RAISE EXCEPTION 'Her float is only %, less than the 10,000,000 to cut. Nothing was written.', v_float_before;
  END IF;

  FOREACH v_tid IN ARRAY ARRAY['TID160005141382', 'TID160005769008'] LOOP
    SELECT g.id, g.amount, g.transaction_id, g.direction, g.parsed INTO v_gm
      FROM gmail_transactions g WHERE g.transaction_id = v_tid;
    IF NOT FOUND OR v_gm.amount <> 5000000 OR v_gm.direction NOT IN ('in', 'credit') OR v_gm.parsed IS NOT TRUE THEN
      RAISE EXCEPTION 'Receipt % is not the UGX 5,000,000 inbound receipt expected. Nothing was written.', v_tid;
    END IF;

    v_norm := regexp_replace(v_tid, '[^0-9]', '', 'g');

    SELECT id INTO v_ret FROM merchant_float_returns WHERE gmail_transaction_id = v_gm.id;
    IF FOUND THEN
      -- Already booked, to the wrong desk as "no_float" with nothing written down: move it to her real desk.
      IF EXISTS (SELECT 1 FROM merchant_float_returns WHERE id = v_ret AND (amount_written_down <> 0 OR ledger_group_id IS NOT NULL)) THEN
        RAISE EXCEPTION 'Receipt % was already written down. Nothing was written.', v_tid;
      END IF;
      UPDATE merchant_float_returns
         SET agent_id = c_agent, desk_id = c_desk, amount_written_down = 5000000, excess_amount = 0,
             float_before = v_float_before, status = 'posted', match_method = 'manual_other_number'
       WHERE id = v_ret;
      UPDATE ledger_reconciled_tids
         SET user_id = c_agent, notes = 'Merchant desk float return from another phone number, booked to her desk by management 28 Oct 2026'
       WHERE tid_normalized = v_norm;
    ELSE
      INSERT INTO merchant_float_returns (gmail_transaction_id, transaction_id, desk_id, agent_id, amount_received,
                                          amount_written_down, excess_amount, float_before, match_method, status)
      VALUES (v_gm.id, v_tid, c_desk, c_agent, 5000000, 5000000, 0, v_float_before, 'manual_other_number', 'posted')
      RETURNING id INTO v_ret;
      INSERT INTO ledger_reconciled_tids (tid_normalized, source, source_id, amount, user_id, notes)
      VALUES (v_norm, 'merchant_float_return', v_ret, 5000000, c_agent,
              'Merchant desk float return from another phone number, booked to her desk by management 28 Oct 2026')
      ON CONFLICT (tid_normalized) DO NOTHING;
    END IF;

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', c_agent, 'amount', 5000000, 'direction', 'cash_out',
          'category', 'merchant_float_correction_writedown', 'ledger_scope', 'wallet', 'wallet_bucket', 'float',
          'recipient_type', 'operational_wallet', 'classification', 'production', 'solvency_bypass_reason', 'other_with_note',
          'source_table', 'merchant_float_returns', 'source_id', v_ret, 'reference_id', v_tid,
          'description', 'Merchant float returned to company (booked by management). UGX 5000000 sent by the desk from another phone number, TID ' || v_tid || '. Float reduced by UGX 5000000.',
          'currency', 'UGX', 'transaction_date', now()),
        jsonb_build_object(
          'amount', 5000000, 'direction', 'cash_in',
          'category', 'merchant_float_correction_writedown', 'ledger_scope', 'platform', 'classification', 'production',
          'source_table', 'merchant_float_returns', 'source_id', v_ret, 'reference_id', v_tid,
          'description', 'Platform: merchant float returned by desk from another phone number (booked by management), TID ' || v_tid,
          'currency', 'UGX', 'transaction_date', now())
      ),
      idempotency_key := 'merchant_float_return:' || v_gm.id::text,
      skip_balance_check := true
    );

    UPDATE merchant_float_returns SET ledger_group_id = v_group WHERE id = v_ret;

    INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (NULL, 'merchant_float_return_manual_recorded', 'merchant_float_returns', v_ret,
            jsonb_build_object('agent_id', c_agent, 'desk_id', c_desk, 'tid', v_tid, 'amount', 5000000,
                               'ledger_group_id', v_group, 'note', 'Sent from another phone number; confirmed by management 28 Oct 2026'));
  END LOOP;

  v_sync := public.sync_merchant_desk_float_cache(c_desk, 'manual float returns from other numbers, 28 Oct 2026');

  SELECT coalesce(float_balance, 0) INTO v_float_after FROM wallets WHERE user_id = c_agent;
  IF v_float_before - v_float_after <> 10000000 THEN
    RAISE EXCEPTION 'Her float went from % to %, not down by exactly 10,000,000. Nothing was written.', v_float_before, v_float_after;
  END IF;

  UPDATE merchant_float_returns SET float_after = v_float_after
   WHERE transaction_id IN ('TID160005141382', 'TID160005769008');
END $$;
