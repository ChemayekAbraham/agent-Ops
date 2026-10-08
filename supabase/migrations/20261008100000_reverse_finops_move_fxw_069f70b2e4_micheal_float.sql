-- One-off: reverse FinOps wallet move FXW-069F70B2E4 (2026-10-08 08:51 UTC).
--
-- What happened: a FinOps operator moved UGX 10,000 from Nankambo sharimah's WITHDRAWABLE
-- bucket into agent Okwakol Micheal's FLOAT (finops_wallet_move, bucket_reclass_out/in) to
-- fund his rent collection. That move carries no TID, so tg_credit_tid_backed_float never
-- counts it and the rent-collection gate still showed "TID-backed balance: 0". The real
-- money (Airtel TID158315386626, UGX 10,000 from 0730647169) arrived at 05:57 UTC and is
-- being routed to Micheal separately through Email Transactions.
--
-- Josh (2026-10-08): "let us reverse it here" (the Wallet Move screen could not do it).
--
-- Shape mirrors the original group exactly with users/buckets swapped, i.e. what
-- finops-wallet-move user_to_user (float -> withdrawable) posts. A fresh reference id; the
-- original rows are untouched. The trigger ignores bucket_reclass_* from finops_wallet_move,
-- so agent_tid_backed_float is not affected either way.
--
-- Guards: refuses if the original group is missing, if it was already reversed, or if
-- Micheal's Float no longer covers 10,000 (no overdraw).
DO $$
DECLARE
  c_micheal  constant uuid    := '75891dff-d684-49e9-83ea-fab6e4cb4ded';
  c_nankambo constant uuid    := '59d45ad2-0d44-433c-b4ec-20927a25c281';
  c_amt      constant numeric := 10000;
  c_orig     constant text    := 'FXW-069F70B2E4';
  c_ref      constant text    := 'FXW-REV069F70B2E4';
  v_float    numeric;
  v_now      timestamptz := now();
  v_desc     text := 'Operator move reversal of ' || 'FXW-069F70B2E4' || ': non-TID bucket move; the real payment TID158315386626 is routed to the agent instead';
BEGIN
  IF EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = c_ref) THEN
    RETURN; -- already applied
  END IF;

  IF (SELECT count(*) FROM public.general_ledger
       WHERE reference_id = c_orig AND amount = c_amt
         AND ((user_id = c_nankambo AND category = 'bucket_reclass_out' AND wallet_bucket = 'withdrawable')
           OR (user_id = c_micheal  AND category = 'bucket_reclass_in'  AND wallet_bucket = 'float'))) <> 2 THEN
    RAISE EXCEPTION 'Original move % not found in expected shape; live state differs', c_orig;
  END IF;

  SELECT float_balance INTO v_float FROM public.wallets WHERE user_id = c_micheal;
  IF COALESCE(v_float, 0) < c_amt THEN
    RAISE EXCEPTION 'Micheal float % is below %; refusing to overdraw', COALESCE(v_float, 0), c_amt;
  END IF;

  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', c_micheal, 'amount', c_amt, 'direction', 'cash_out',
        'category', 'bucket_reclass_out', 'ledger_scope', 'wallet',
        'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
        'routing_source', 'finops_wallet_move', 'source_table', 'finops_wallet_move',
        'reference_id', c_ref, 'classification', 'production', 'currency', 'UGX',
        'transaction_date', v_now, 'linked_party', 'Nankambo sharimah',
        'description', 'Operator move: sent UGX 10,000 from Float to Nankambo sharimah (Withdrawable). [Failed funding reversal] ' || v_desc),
      jsonb_build_object(
        'user_id', c_nankambo, 'amount', c_amt, 'direction', 'cash_in',
        'category', 'bucket_reclass_in', 'ledger_scope', 'wallet',
        'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
        'routing_source', 'finops_wallet_move', 'source_table', 'finops_wallet_move',
        'reference_id', c_ref, 'classification', 'production', 'currency', 'UGX',
        'transaction_date', v_now, 'linked_party', 'Okwakol Micheal',
        'description', 'Operator move: received UGX 10,000 into Withdrawable from Okwakol Micheal (Float). [Failed funding reversal] ' || v_desc)
    ),
    idempotency_key := 'finops_move_reversal:' || c_orig,
    skip_balance_check := true
  );

  PERFORM public.reconcile_wallet_from_ledger(c_micheal);
  PERFORM public.reconcile_wallet_from_ledger(c_nankambo);

  BEGIN
    INSERT INTO public.system_events (event_type, description, metadata)
    VALUES ('wallet.finops_move',
            'Reversed FinOps move ' || c_orig || ': UGX 10,000 from Micheal Float back to Nankambo Withdrawable',
            jsonb_build_object('original_reference', c_orig, 'reference_id', c_ref, 'amount', c_amt));
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never fail a posted move on an event write
  END;
END $$;
