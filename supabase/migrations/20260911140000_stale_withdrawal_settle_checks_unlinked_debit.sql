-- ============================================================
-- Fix: cfo_reconcile_stale_withdrawal could double-debit a wallet
-- ============================================================
-- Found investigating Fredrick Baliddawa's wallet (UGX 1,800,000 short):
--   1. Apr 1  — ROI payout credits his wallet UGX 1,800,000.
--   2. Apr 1  — He withdraws that same UGX 1,800,000 via mobile money;
--               the withdrawal_requests row is approved/processed same day
--               but its wallet-side debit never gets posted to the ledger,
--               so the hold lingers (status stays in an unsettled state).
--   3. Apr 13 — A CFO manually debits his wallet UGX 1,800,000 via the
--               generic "CFO Direct Credit/Debit" tool ("Wallet Retraction"),
--               correctly catching up the missing debit — but that tool
--               never links the ledger row back to the withdrawal
--               (source_table = 'cfo_direct_credit', source_id = NULL).
--   4. Aug 12 — The stale-withdrawal-hold sweep finds the withdrawal still
--               has no *linked* debit (its only guard checks
--               general_ledger.source_table = 'withdrawal_requests') and
--               calls cfo_reconcile_stale_withdrawal(..., 'settle'), which
--               posts a SECOND UGX 1,800,000 debit for the same payout.
--
-- Net: one real withdrawal charged twice. The existing guard only catches
-- a duplicate that was itself posted through this same linked path; it is
-- blind to an equivalent debit posted through any other route (manual CFO
-- correction, etc). Add a second guard: before settling, look for any
-- unlinked wallet-scope cash_out of the same amount for the same user in
-- a window around the withdrawal, and require a human to verify rather
-- than silently posting a second debit.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cfo_reconcile_stale_withdrawal(
  p_withdrawal_id uuid,
  p_action text,
  p_reason text,
  p_payment_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wr public.withdrawal_requests;
  v_hold_user uuid;
  v_before numeric;
  v_after numeric;
  v_group uuid;
  v_new_status text;
  v_actor uuid := auth.uid();
  v_unlinked_match record;
BEGIN
  IF NOT public.is_withdrawal_hold_reviewer(v_actor) THEN
    RAISE EXCEPTION 'Not authorized to reconcile withdrawal holds';
  END IF;

  IF p_action NOT IN ('settle','cancel') THEN
    RAISE EXCEPTION 'Invalid action: expected settle or cancel';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A written reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_wr FROM public.withdrawal_requests WHERE id = p_withdrawal_id FOR UPDATE;
  IF v_wr.id IS NULL THEN
    RAISE EXCEPTION 'Withdrawal request not found';
  END IF;

  IF v_wr.status NOT IN ('pending','requested','manager_approved','processing','approved') THEN
    RAISE EXCEPTION 'Withdrawal is % and no longer holds balance', v_wr.status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.source_table = 'withdrawal_requests' AND g.source_id = v_wr.id
      AND g.ledger_scope = 'wallet' AND g.direction IN ('cash_out','debit')
  ) THEN
    RAISE EXCEPTION 'This withdrawal already has a wallet debit — nothing to reconcile';
  END IF;

  IF EXISTS (SELECT 1 FROM public.withdrawal_hold_reconciliations WHERE withdrawal_id = v_wr.id) THEN
    RAISE EXCEPTION 'This withdrawal has already been reconciled';
  END IF;

  v_hold_user := CASE WHEN v_wr.proxy_partner_id IS NOT NULL AND v_wr.agent_id IS NOT NULL
                      THEN v_wr.agent_id ELSE v_wr.user_id END;

  -- Guard against re-debiting a payout that was already covered by some
  -- OTHER (unlinked) wallet debit — e.g. a manual CFO correction that
  -- never recorded source_table/source_id back to this withdrawal. Only
  -- applies to 'settle', which is the branch that posts a new debit.
  IF p_action = 'settle' THEN
    SELECT g.id, g.transaction_date, g.description INTO v_unlinked_match
    FROM public.general_ledger g
    WHERE g.user_id = v_hold_user
      AND g.ledger_scope = 'wallet'
      AND g.direction IN ('cash_out','debit')
      AND g.amount = v_wr.amount
      AND g.source_table IS DISTINCT FROM 'withdrawal_requests'
      AND g.transaction_date BETWEEN v_wr.created_at - interval '1 day'
                                  AND v_wr.created_at + interval '180 days'
    ORDER BY g.transaction_date ASC
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'POSSIBLE_DUPLICATE_DEBIT: an unlinked wallet debit of the same amount (%) already exists for this user (ledger entry %, %, "%") within the window around this withdrawal. It may already cover this payout. Verify manually — e.g. against mobile money reference % — before settling, to avoid a duplicate debit.',
        v_wr.amount, v_unlinked_match.id, v_unlinked_match.transaction_date, v_unlinked_match.description, v_wr.transaction_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT COALESCE(withdrawable, 0) INTO v_before
  FROM public.wallet_balances_projection WHERE user_id = v_hold_user;

  IF p_action = 'settle' THEN
    -- The payout genuinely happened: post the missing double-entry through the
    -- normal ledger engine. No wallet field is touched directly.
    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_hold_user,
          'amount', v_wr.amount,
          'direction', 'cash_out',
          'category', 'wallet_withdrawal',
          'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable',
          'recipient_type', 'user',
          'currency', 'UGX',
          'source_table', 'withdrawal_requests',
          'source_id', v_wr.id,
          'transaction_date', now(),
          'description', 'Backdated wallet debit for reconciled withdrawal ' || v_wr.id::text,
          'metadata', jsonb_build_object(
            'reconciliation', 'stale_withdrawal_hold',
            'payment_reference', p_payment_reference,
            'decided_by', v_actor
          )
        ),
        jsonb_build_object(
          'amount', v_wr.amount,
          'direction', 'cash_in',
          'category', 'wallet_withdrawal',
          'ledger_scope', 'platform',
          'currency', 'UGX',
          'source_table', 'withdrawal_requests',
          'source_id', v_wr.id,
          'transaction_date', now(),
          'description', 'Platform records reconciled withdrawal payout ' || v_wr.id::text
        )
      ),
      idempotency_key := 'stale-hold-settle-' || v_wr.id::text,
      skip_balance_check := true
    );

    v_new_status := 'completed';
    UPDATE public.withdrawal_requests
       SET status = 'completed',
           processed_at = COALESCE(processed_at, now()),
           processed_by = COALESCE(processed_by, v_actor),
           fin_ops_reference = COALESCE(p_payment_reference, fin_ops_reference)
     WHERE id = v_wr.id;
  ELSE
    v_new_status := 'cancelled';
    UPDATE public.withdrawal_requests
       SET status = 'cancelled',
           rejection_reason = 'Hold reconciliation: ' || btrim(p_reason),
           processed_at = COALESCE(processed_at, now()),
           processed_by = COALESCE(processed_by, v_actor)
     WHERE id = v_wr.id;
  END IF;

  PERFORM public.refresh_wallet_projection_for(v_hold_user);

  SELECT COALESCE(withdrawable, 0) INTO v_after
  FROM public.wallet_balances_projection WHERE user_id = v_hold_user;

  INSERT INTO public.withdrawal_hold_reconciliations (
    withdrawal_id, hold_user_id, amount, action, reason, payment_reference,
    ledger_group_id, previous_status, new_status,
    withdrawable_before, withdrawable_after, decided_by, metadata
  ) VALUES (
    v_wr.id, v_hold_user, v_wr.amount,
    CASE WHEN p_action = 'settle' THEN 'settled' ELSE 'cancelled' END,
    btrim(p_reason), p_payment_reference, v_group, v_wr.status, v_new_status,
    v_before, v_after, v_actor,
    jsonb_build_object('mobile_money_number', v_wr.mobile_money_number,
                       'mobile_money_reference', v_wr.transaction_id)
  );

  UPDATE public.withdrawal_hold_alerts
     SET status = 'resolved', resolved_at = now()
   WHERE withdrawal_id = v_wr.id AND status <> 'resolved';

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor,
    CASE WHEN p_action = 'settle' THEN 'WITHDRAWAL_HOLD_SETTLED' ELSE 'WITHDRAWAL_HOLD_CANCELLED' END,
    'withdrawal_requests',
    v_wr.id::text,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'amount', v_wr.amount,
      'hold_user_id', v_hold_user,
      'previous_status', v_wr.status,
      'new_status', v_new_status,
      'payment_reference', p_payment_reference,
      'ledger_group_id', v_group,
      'withdrawable_before', v_before,
      'withdrawable_after', v_after
    )
  );

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('withdrawal_approved', v_hold_user,
            jsonb_build_object('kind', 'withdrawal_hold_reconciled',
                               'action', p_action,
                               'withdrawal_id', v_wr.id,
                               'amount', v_wr.amount));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'withdrawal_id', v_wr.id,
    'action', p_action,
    'new_status', v_new_status,
    'ledger_group_id', v_group,
    'withdrawable_before', v_before,
    'withdrawable_after', v_after
  );
END;
$$;
