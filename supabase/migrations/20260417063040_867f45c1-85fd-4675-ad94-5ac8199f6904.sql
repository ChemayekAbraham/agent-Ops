-- Corrective backfill: prior portfolio top-ups (manager + reconciliation flows) erroneously
-- posted the pending-capital "cash_in" credit at ledger_scope='wallet' instead of 'platform'.
-- This net-zeroed the wallet deduction for partners whose investor_id == agent_id (or where
-- the wallet owner == partner). Money never actually left their wallet, and platform shows
-- a phantom liability.
--
-- Fix: for each bogus entry, post a corrective pair that
--   (a) deducts the over-credited amount from the wallet (capped to current balance), and
--   (b) parks the same amount on platform scope as pending capital — keeping the ledger balanced.
--
-- We mark the corrective entries with a distinct category description and source_table=
-- 'general_ledger' referencing the original bogus row, so it's auditable and idempotent.

DO $$
DECLARE
  r RECORD;
  v_current_balance numeric;
  v_already_corrected boolean;
  v_actual_deduction numeric;
BEGIN
  FOR r IN
    SELECT id, user_id, amount, source_id, source_table, description
    FROM general_ledger
    WHERE category = 'pending_portfolio_topup'
      AND direction = 'cash_in'
      AND ledger_scope = 'wallet'
    ORDER BY created_at
  LOOP
    -- Skip if already corrected (idempotency)
    SELECT EXISTS (
      SELECT 1 FROM general_ledger
      WHERE category = 'system_balance_correction'
        AND source_table = 'general_ledger'
        AND source_id = r.id
    ) INTO v_already_corrected;

    IF v_already_corrected THEN
      CONTINUE;
    END IF;

    -- Get current wallet balance; cap correction so we never create a negative wallet
    SELECT balance INTO v_current_balance FROM wallets WHERE user_id = r.user_id;
    IF v_current_balance IS NULL THEN
      v_current_balance := 0;
    END IF;

    v_actual_deduction := LEAST(r.amount, v_current_balance);

    IF v_actual_deduction <= 0 THEN
      -- Wallet is empty — nothing to deduct (money was likely spent elsewhere).
      -- Still log a zero-amount audit record so we don't keep retrying.
      INSERT INTO audit_logs (action_type, table_name, record_id, metadata)
      VALUES (
        'pending_topup_scope_correction_skipped',
        'general_ledger',
        r.id,
        jsonb_build_object(
          'reason', 'wallet_empty',
          'user_id', r.user_id,
          'bogus_amount', r.amount,
          'current_balance', v_current_balance
        )
      );
      CONTINUE;
    END IF;

    -- Post the corrective ledger pair via the safe RPC
    PERFORM create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', r.user_id,
          'amount', v_actual_deduction,
          'direction', 'cash_out',
          'category', 'system_balance_correction',
          'ledger_scope', 'wallet',
          'description', 'Correction: reversing bogus wallet credit from pending portfolio top-up',
          'source_table', 'general_ledger',
          'source_id', r.id,
          'currency', 'UGX'
        ),
        jsonb_build_object(
          'user_id', r.user_id,
          'amount', v_actual_deduction,
          'direction', 'cash_in',
          'category', 'system_balance_correction',
          'ledger_scope', 'platform',
          'description', 'Correction: parking pending capital on platform scope (was wallet)',
          'source_table', 'general_ledger',
          'source_id', r.id,
          'currency', 'UGX'
        )
      ),
      'pending_topup_scope_fix_' || r.id::text,
      true  -- skip_balance_check (this is a corrective entry)
    );

    INSERT INTO audit_logs (action_type, table_name, record_id, metadata)
    VALUES (
      'pending_topup_scope_correction_applied',
      'general_ledger',
      r.id,
      jsonb_build_object(
        'user_id', r.user_id,
        'bogus_amount', r.amount,
        'actual_deduction', v_actual_deduction,
        'wallet_balance_before', v_current_balance
      )
    );
  END LOOP;
END $$;