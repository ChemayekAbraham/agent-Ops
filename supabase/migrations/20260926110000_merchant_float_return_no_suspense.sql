-- Merchant float returns: no suspense account, and counted on the balance sheet.
--
-- CEO directive 2026-09-26: "Remove suspense account. Actual should be actual."
-- Actual = money on the company MTN line, Airtel line and Mercy's Equity account.
-- MAF = Merchant Agent Float. Money out to a merchant agent: Actual down, MAF up.
-- Money back from a merchant agent: MAF down, Actual up.
--
-- 1. MAPPING. The platform leg of merchant_float_correction_writedown had no
--    ledger_account_map row, so it fell through to A9 (Suspense). Float sent
--    to a merchant agent posts wallet agent_float_deposit (DR A2) with platform
--    agent_float_deposit (CR A8). A return / write-down is its exact mirror:
--    wallet float cash_out (CR A2) with platform cash_in (DR A8). Mapping the
--    platform leg to A8, debit_when cash_in, takes the 9M of 2026-09-25 out of
--    suspense: the wrong deposits' CR A8 and the write-downs' DR A8 cancel, as
--    they should, because those deposits never happened economically.
--    Only 2 historical legs use this category (both 2026-09-25, UGX 9,000,000),
--    and no edge function references it.
--
-- 2. CLASSIFICATION. Automatic returns were posted as admin_correction with
--    source_table merchant_float_returns. The balance-sheet resolver only admits
--    admin_correction legs from merchant_float_reconciliations, so automatic
--    returns would have been dropped from the balance sheet while still moving
--    the wallet. They are real money movements: post them as production.

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
SELECT 'platform', 'merchant_float_correction_writedown', NULL, 'A8', 'cash_in',
       'Merchant float return / write-down: mirror of agent_float_deposit platform leg (CR A8). Was unmapped -> A9 suspense until 2026-09-26.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ledger_account_map
   WHERE ledger_scope = 'platform' AND category = 'merchant_float_correction_writedown'
     AND wallet_bucket IS NULL
);

CREATE OR REPLACE FUNCTION public.auto_record_merchant_float_return(
  p_gmail_transaction_id uuid,
  p_agent_id uuid,
  p_match_method text DEFAULT 'phone'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tx          record;
  v_existing    record;
  v_desk_id     uuid;
  v_tid_norm    text;
  v_float       numeric;
  v_post        numeric;
  v_excess      numeric;
  v_status      text;
  v_return_id   uuid;
  v_group_id    uuid;
  v_float_after numeric;
  v_sync        jsonb;
  v_reason      text;
  v_alert_label constant text := 'Merchant desk sent money to the company - check the float return';
BEGIN
  SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.direction,
         g.parsed, g.linked_deposit_request_id
    INTO v_tx
    FROM gmail_transactions g
   WHERE g.id = p_gmail_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'gmail_row_not_found');
  END IF;

  IF v_tx.parsed IS NOT TRUE
     OR v_tx.direction NOT IN ('in','credit')
     OR coalesce(v_tx.amount, 0) <= 0
     OR nullif(btrim(coalesce(v_tx.transaction_id, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'not_an_inbound_receipt');
  END IF;

  SELECT id INTO v_desk_id
    FROM cashout_agents
   WHERE agent_id = p_agent_id AND is_active IS TRUE
   ORDER BY created_at
   LIMIT 1;
  IF v_desk_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'not_a_merchant_desk');
  END IF;

  -- Serialise per desk so two receipts cannot both read the same float.
  PERFORM pg_advisory_xact_lock(hashtext('merchant_float_return:' || p_agent_id::text));

  -- Idempotent: the same receipt is only ever recorded once.
  SELECT * INTO v_existing
    FROM merchant_float_returns
   WHERE gmail_transaction_id = v_tx.id
      OR lower(btrim(transaction_id)) = lower(btrim(v_tx.transaction_id))
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'already_recorded',
                              'return_id', v_existing.id, 'status', v_existing.status);
  END IF;

  v_tid_norm := coalesce(public.extract_tid_normalized(v_tx.transaction_id),
                         nullif(regexp_replace(v_tx.transaction_id, '[^0-9]', '', 'g'), ''),
                         lower(btrim(v_tx.transaction_id)));

  v_reason := NULL;
  IF v_tx.linked_deposit_request_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM deposit_requests d
                 WHERE d.transaction_id IS NOT NULL
                   AND lower(btrim(d.transaction_id)) = lower(btrim(v_tx.transaction_id))) THEN
    -- The desk (or a person) already filed this TID as a deposit. That is an
    -- explicit decision; do not second-guess it automatically.
    v_reason := 'tid_already_filed_as_deposit';
  ELSIF EXISTS (SELECT 1 FROM ledger_reconciled_tids WHERE tid_normalized = v_tid_norm) THEN
    v_reason := 'tid_already_credited';
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO deposit_match_alerts (
      alert_type, subject_id, subject_label, user_id, amount,
      transaction_reference, severity, details, resolved_at, updated_at
    ) VALUES (
      'merchant_float_return', v_tx.id, v_alert_label, p_agent_id, v_tx.amount,
      v_tx.transaction_id, 'high',
      jsonb_build_object('reason', v_reason, 'desk_id', v_desk_id,
                         'counterparty', v_tx.counterparty, 'observed_at', now()),
      NULL, now()
    )
    ON CONFLICT (alert_type, subject_id) DO UPDATE SET updated_at = excluded.updated_at;
    RETURN jsonb_build_object('ok', false, 'outcome', v_reason);
  END IF;

  SELECT coalesce(float_balance, 0) INTO v_float FROM wallets WHERE user_id = p_agent_id;
  v_float  := greatest(coalesce(v_float, 0), 0);
  v_post   := least(round(v_tx.amount), round(v_float));
  v_excess := round(v_tx.amount) - v_post;
  v_status := CASE WHEN v_post <= 0 THEN 'no_float'
                   WHEN v_excess > 0 THEN 'partial'
                   ELSE 'posted' END;

  INSERT INTO merchant_float_returns (
    gmail_transaction_id, transaction_id, desk_id, agent_id, amount_received,
    amount_written_down, excess_amount, float_before, match_method, status
  ) VALUES (
    v_tx.id, btrim(v_tx.transaction_id), v_desk_id, p_agent_id, v_tx.amount,
    v_post, v_excess, v_float, p_match_method, v_status
  ) RETURNING id INTO v_return_id;

  IF v_post > 0 THEN
    v_group_id := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', p_agent_id,
          'amount', v_post,
          'direction', 'cash_out',
          'category', 'merchant_float_correction_writedown',
          'ledger_scope', 'wallet',
          'wallet_bucket', 'float',
          'recipient_type', 'operational_wallet',
          'classification', 'production',
          'solvency_bypass_reason', 'other_with_note',
          'source_table', 'merchant_float_returns',
          'source_id', v_return_id,
          'reference_id', btrim(v_tx.transaction_id),
          'description', format(
            'Merchant float returned to company (automatic). UGX %s received from the desk phone on a company line, TID %s. Float reduced by UGX %s.',
            v_tx.amount, btrim(v_tx.transaction_id), v_post),
          'currency', 'UGX',
          'transaction_date', now()
        ),
        jsonb_build_object(
          'amount', v_post,
          'direction', 'cash_in',
          'category', 'merchant_float_correction_writedown',
          'ledger_scope', 'platform',
          'classification', 'production',
          'source_table', 'merchant_float_returns',
          'source_id', v_return_id,
          'reference_id', btrim(v_tx.transaction_id),
          'description', 'Platform: merchant float returned by desk (automatic), TID ' || btrim(v_tx.transaction_id),
          'currency', 'UGX',
          'transaction_date', now()
        )
      ),
      idempotency_key := 'merchant_float_return:' || v_tx.id::text,
      skip_balance_check := true
    );

    v_sync := public.sync_merchant_desk_float_cache(v_desk_id, 'automatic float return ' || v_return_id::text);
  END IF;

  SELECT coalesce(float_balance, 0) INTO v_float_after FROM wallets WHERE user_id = p_agent_id;

  UPDATE merchant_float_returns
     SET ledger_group_id = v_group_id,
         float_after     = v_float_after
   WHERE id = v_return_id;

  -- Consume the TID so it can never also be credited as a deposit.
  INSERT INTO ledger_reconciled_tids (tid_normalized, source, source_id, amount, user_id, notes)
  VALUES (v_tid_norm, 'merchant_float_return', v_return_id, v_tx.amount, p_agent_id,
          'Merchant desk float return, recorded automatically from the provider receipt')
  ON CONFLICT (tid_normalized) DO NOTHING;

  IF v_status <> 'posted' THEN
    INSERT INTO deposit_match_alerts (
      alert_type, subject_id, subject_label, user_id, amount,
      transaction_reference, severity, details, resolved_at, updated_at
    ) VALUES (
      'merchant_float_return', v_tx.id, v_alert_label, p_agent_id, v_tx.amount,
      v_tx.transaction_id, 'high',
      jsonb_build_object(
        'reason', CASE WHEN v_status = 'no_float' THEN 'desk_had_no_float_on_books'
                       ELSE 'return_exceeds_float_on_books' END,
        'desk_id', v_desk_id, 'return_id', v_return_id,
        'float_before', v_float, 'written_down', v_post, 'excess', v_excess,
        'counterparty', v_tx.counterparty, 'observed_at', now()),
      NULL, now()
    )
    ON CONFLICT (alert_type, subject_id) DO UPDATE SET updated_at = excluded.updated_at;
  END IF;

  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (NULL, 'merchant_float_return_auto_recorded', 'merchant_float_returns', v_return_id,
          jsonb_build_object('desk_id', v_desk_id, 'agent_id', p_agent_id,
                             'gmail_transaction_id', v_tx.id, 'tid', v_tx.transaction_id,
                             'amount_received', v_tx.amount, 'written_down', v_post,
                             'excess', v_excess, 'float_before', v_float,
                             'float_after', v_float_after, 'ledger_group_id', v_group_id,
                             'match_method', p_match_method, 'cache_sync', v_sync));

  RETURN jsonb_build_object(
    'ok', true, 'outcome', v_status, 'return_id', v_return_id,
    'ledger_group_id', v_group_id, 'amount_received', v_tx.amount,
    'written_down', v_post, 'excess', v_excess,
    'float_before', v_float, 'float_after', v_float_after
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_record_merchant_float_return(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_record_merchant_float_return(uuid, uuid, text) TO service_role;
