-- Sender can reverse a user-to-user transfer while the recipient has not
-- withdrawn since receiving it. Returns what is still available, capped at
-- the amount sent. One reversal per transfer. Ledger-only (create_ledger_transaction).
CREATE OR REPLACE FUNCTION public.wallet_transfer_reversal_status(p_reference text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_out record;
  v_in record;
  v_avail numeric;
  v_amount numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('can_reverse', false, 'reason', 'Please sign in.');
  END IF;

  SELECT * INTO v_out FROM general_ledger
   WHERE reference_id = p_reference AND category = 'wallet_transfer'
     AND direction = 'cash_out' AND ledger_scope = 'wallet'
   ORDER BY created_at LIMIT 1;
  SELECT * INTO v_in FROM general_ledger
   WHERE reference_id = p_reference AND category = 'wallet_transfer'
     AND direction = 'cash_in' AND ledger_scope = 'wallet'
   ORDER BY created_at LIMIT 1;

  IF v_out.id IS NULL OR v_in.id IS NULL OR v_out.user_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('can_reverse', false, 'reason', 'Only the sender can reverse this transfer.');
  END IF;

  IF EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = 'reversal:' || p_reference) THEN
    RETURN jsonb_build_object('can_reverse', false, 'reason', 'This transfer has already been reversed.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM withdrawal_requests w
     WHERE w.user_id = v_in.user_id
       AND w.created_at >= v_in.created_at
       AND coalesce(w.status,'') NOT IN ('rejected','cancelled','failed')
  ) THEN
    RETURN jsonb_build_object('can_reverse', false, 'reason', 'The recipient has already withdrawn, so this transfer can no longer be reversed.');
  END IF;

  v_avail := coalesce(public.get_user_available_balance(v_in.user_id), 0);
  v_amount := floor(least(v_in.amount, greatest(v_avail, 0)));

  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('can_reverse', false, 'reason', 'The recipient has no money left in their wallet to return.');
  END IF;

  RETURN jsonb_build_object(
    'can_reverse', true,
    'sent', v_in.amount,
    'reversible', v_amount,
    'recipient_id', v_in.user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_wallet_transfer(p_reference text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status jsonb;
  v_amount numeric;
  v_recipient uuid;
  v_group uuid;
  v_sender_name text;
  v_recipient_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in.';
  END IF;

  -- Serialise per transfer and per recipient so two reversals or a
  -- reversal racing a withdrawal cannot double-spend.
  PERFORM pg_advisory_xact_lock(abs(hashtext('reversal:' || p_reference)));

  v_status := public.wallet_transfer_reversal_status(p_reference);
  IF NOT coalesce((v_status->>'can_reverse')::boolean, false) THEN
    RAISE EXCEPTION '%', v_status->>'reason';
  END IF;

  v_recipient := (v_status->>'recipient_id')::uuid;
  PERFORM pg_advisory_xact_lock(abs(hashtext('wallet-reversal-user:' || v_recipient::text)));

  -- Re-read after taking the recipient lock.
  v_status := public.wallet_transfer_reversal_status(p_reference);
  IF NOT coalesce((v_status->>'can_reverse')::boolean, false) THEN
    RAISE EXCEPTION '%', v_status->>'reason';
  END IF;
  v_amount := (v_status->>'reversible')::numeric;

  SELECT coalesce(nullif(trim(full_name),''), phone, 'Welile user') INTO v_sender_name FROM profiles WHERE id = v_uid;
  SELECT coalesce(nullif(trim(full_name),''), phone, 'Welile user') INTO v_recipient_name FROM profiles WHERE id = v_recipient;

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_recipient, 'amount', v_amount, 'direction', 'cash_out',
        'category', 'wallet_transfer', 'ledger_scope', 'wallet',
        'source_table', 'wallet_transactions',
        'description', 'Transfer reversed by ' || coalesce(v_sender_name,'sender') || ' (Ref ' || p_reference || ')',
        'currency', 'UGX', 'transaction_date', now(),
        'reference_id', p_reference || '-REV', 'linked_party', v_sender_name,
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable'),
      jsonb_build_object(
        'user_id', v_uid, 'amount', v_amount, 'direction', 'cash_in',
        'category', 'wallet_transfer', 'ledger_scope', 'wallet',
        'source_table', 'wallet_transactions',
        'description', 'Reversal of transfer to ' || coalesce(v_recipient_name,'recipient') || ' (Ref ' || p_reference || ')',
        'currency', 'UGX', 'transaction_date', now(),
        'reference_id', p_reference || '-REV', 'linked_party', v_recipient_name,
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable')
    ),
    'reversal:' || p_reference
  );

  INSERT INTO system_events (event_type, user_id, related_entity_type, metadata, actor_id, subject_id, source)
  VALUES ('wallet_transfer', v_uid, 'general_ledger',
          jsonb_build_object('action','sender_reversal','original_reference',p_reference,
                             'reversal_reference',p_reference || '-REV','amount',v_amount,
                             'sent',(v_status->>'sent')::numeric,'recipient_id',v_recipient,
                             'transaction_group_id',v_group),
          v_uid, v_recipient, 'reverse_wallet_transfer');

  RETURN jsonb_build_object('success', true, 'amount', v_amount,
                            'sent', (v_status->>'sent')::numeric,
                            'reference', p_reference || '-REV');
END;
$$;

REVOKE ALL ON FUNCTION public.wallet_transfer_reversal_status(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_wallet_transfer(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wallet_transfer_reversal_status(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_wallet_transfer(text) TO authenticated;