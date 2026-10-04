-- 1) Withdrawals take the same per-user lock as sender reversals, so a
--    reversal and a recipient withdrawal serialise: whichever commits first
--    wins and the other re-checks against the committed state.
CREATE OR REPLACE FUNCTION public.lock_wallet_for_transfer_reversal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(abs(hashtext('wallet-reversal-user:' || NEW.user_id::text)));
  END IF;
  RETURN NEW;
END;
$$;

-- "aaa_" so it fires before every other BEFORE INSERT trigger, including the
-- ledger-match balance gate, which then sees any reversal that just committed.
DROP TRIGGER IF EXISTS aaa_trg_lock_wallet_for_transfer_reversal ON public.withdrawal_requests;
CREATE TRIGGER aaa_trg_lock_wallet_for_transfer_reversal
BEFORE INSERT ON public.withdrawal_requests
FOR EACH ROW EXECUTE FUNCTION public.lock_wallet_for_transfer_reversal();

-- 2) Allow transfer-reversal in-app notifications through the insert filter.
CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF COALESCE(NEW.type, '') IN (
    'merchandise_recovery','director_requisition','advance_arrears','budget',
    'staff_requisition','hr_birthday','rd_alert','lending_repayment',
    'float','bike_lease_reminder','wallet_transfer_reversal'
  ) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'action','') IN ('listing_rejected','subagent_listing_rejected') THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;

-- 3) Reversal: take the recipient lock BEFORE the eligibility check, then
--    notify both parties.
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
  v_sent numeric;
  v_recipient uuid;
  v_group uuid;
  v_sender_name text;
  v_recipient_name text;
  v_amt_txt text;
  v_sent_txt text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in.';
  END IF;

  PERFORM pg_advisory_xact_lock(abs(hashtext('reversal:' || p_reference)));

  SELECT user_id INTO v_recipient FROM general_ledger
   WHERE reference_id = p_reference AND category = 'wallet_transfer'
     AND direction = 'cash_in' AND ledger_scope = 'wallet'
   ORDER BY created_at LIMIT 1;
  IF v_recipient IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(abs(hashtext('wallet-reversal-user:' || v_recipient::text)));
  END IF;

  -- Checked only after both locks are held: any withdrawal that won the
  -- race is committed and visible here.
  v_status := public.wallet_transfer_reversal_status(p_reference);
  IF NOT coalesce((v_status->>'can_reverse')::boolean, false) THEN
    RAISE EXCEPTION '%', v_status->>'reason';
  END IF;
  v_recipient := (v_status->>'recipient_id')::uuid;
  v_amount := (v_status->>'reversible')::numeric;
  v_sent := (v_status->>'sent')::numeric;

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
                             'sent',v_sent,'recipient_id',v_recipient,
                             'transaction_group_id',v_group),
          v_uid, v_recipient, 'reverse_wallet_transfer');

  v_amt_txt := 'UGX ' || to_char(v_amount, 'FM999,999,999,990');
  v_sent_txt := 'UGX ' || to_char(v_sent, 'FM999,999,999,990');

  INSERT INTO notifications (user_id, title, message, type, metadata, event_key, link_path)
  VALUES
    (v_uid, 'Transfer reversed',
     v_amt_txt || ' was returned to your wallet from ' || coalesce(v_recipient_name,'the recipient')
       || CASE WHEN v_amount < v_sent THEN ' (of ' || v_sent_txt || ' sent)' ELSE '' END
       || '. Ref ' || p_reference || '.',
     'wallet_transfer_reversal',
     jsonb_build_object('role','sender','amount',v_amount,'sent',v_sent,'reference',p_reference),
     'transfer-reversal:' || p_reference || ':sender', '/transactions'),
    (v_recipient, 'Transfer reversed',
     coalesce(v_sender_name,'The sender') || ' reversed their transfer. ' || v_amt_txt
       || ' was taken back from your wallet'
       || CASE WHEN v_amount < v_sent THEN ' (of ' || v_sent_txt || ' received)' ELSE '' END
       || '. Ref ' || p_reference || '.',
     'wallet_transfer_reversal',
     jsonb_build_object('role','recipient','amount',v_amount,'sent',v_sent,'reference',p_reference),
     'transfer-reversal:' || p_reference || ':recipient', '/transactions');

  RETURN jsonb_build_object('success', true, 'amount', v_amount, 'sent', v_sent,
                            'reference', p_reference || '-REV');
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_wallet_transfer(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_wallet_transfer(text) TO authenticated;
REVOKE ALL ON FUNCTION public.lock_wallet_for_transfer_reversal() FROM PUBLIC, anon, authenticated;