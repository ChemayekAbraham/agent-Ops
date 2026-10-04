DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'system_event_type'
      AND e.enumlabel = 'wallet_historical_drift_absorbed'
  ) THEN
    ALTER TYPE public.system_event_type ADD VALUE 'wallet_historical_drift_absorbed';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.apply_layer_a_writedown(p_user_id uuid, p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_is_privileged boolean := false;
  v_phantom record;
  v_strict_net numeric;
  v_post_apr_credits numeric;
  v_anchor_exists boolean;
  v_baseline_exists boolean;
  v_entries jsonb;
  v_tx_id uuid;
  v_writedown_amount numeric;
BEGIN
  IF v_caller IS NOT NULL THEN
    v_is_privileged := has_role(v_caller, 'cfo'::app_role) OR has_role(v_caller, 'manager'::app_role);
  ELSE
    v_is_privileged := (current_user IN ('service_role','postgres','supabase_admin'))
                       OR pg_has_role(current_user, 'service_role', 'MEMBER');
  END IF;

  IF NOT v_is_privileged THEN
    RAISE EXCEPTION 'Only CFO, Manager, or service role may run Layer A write-down';
  END IF;

  SELECT * INTO v_phantom
  FROM phantom_wallet_drift
  WHERE user_id = p_user_id
    AND status = 'open'
    AND drift_type = 'negative_overdebit'
  ORDER BY last_detected_at DESC
  LIMIT 1;

  IF v_phantom IS NULL THEN
    RETURN jsonb_build_object('user_id', p_user_id, 'status', 'skipped', 'reason', 'no_open_negative_overdebit_row');
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END), 0)
  INTO v_strict_net
  FROM general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND classification IN ('production','admin_correction');

  SELECT COALESCE(SUM(amount), 0)
  INTO v_post_apr_credits
  FROM general_ledger
  WHERE user_id = p_user_id
    AND direction IN ('cash_in','credit')
    AND ledger_scope = 'wallet'
    AND classification = 'production'
    AND created_at >= '2026-04-01'
    AND category NOT IN ('system_balance_correction','agent_float_topup','agent_float_recovery',
                         'agent_float_deposit','agent_float_used_for_rent','agent_float_settlement',
                         'advance_repayment','advance_disbursement','historical_balance_reseed',
                         'platform_loss_writeoff','partner_funding');

  IF v_post_apr_credits > 0 AND v_strict_net > 0 THEN
    RETURN jsonb_build_object(
      'user_id', p_user_id, 'status', 'blocked',
      'reason', 'user_has_unspent_post_apr_credits',
      'strict_net', v_strict_net, 'post_apr_credits', v_post_apr_credits
    );
  END IF;

  v_writedown_amount := ABS(LEAST(v_strict_net, 0));

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'user_id', p_user_id, 'status', 'would_apply',
      'strict_net', v_strict_net, 'writedown_amount', v_writedown_amount,
      'phantom_id', v_phantom.id
    );
  END IF;

  SELECT EXISTS(SELECT 1 FROM wallet_fresh_start_anchors WHERE user_id = p_user_id) INTO v_anchor_exists;
  IF NOT v_anchor_exists THEN
    INSERT INTO wallet_fresh_start_anchors (user_id, anchor_at, pre_anchor_ledger_net, reason, created_by, notes)
    VALUES (p_user_id, now(), v_strict_net, 'layer_a_historical_drift_writedown', v_caller,
            'Layer A: zero anchor — historical loss absorbed by company');
  END IF;

  SELECT EXISTS(SELECT 1 FROM wallet_ledger_baseline WHERE user_id = p_user_id) INTO v_baseline_exists;
  IF v_baseline_exists THEN
    UPDATE wallet_ledger_baseline
    SET withdrawable_at_baseline = 0,
        ledger_net_at_baseline = 0,
        baseline_at = now(),
        baseline_reason = 'Layer A: zeroed at fresh-start anchor'
    WHERE user_id = p_user_id;
  ELSE
    INSERT INTO wallet_ledger_baseline (user_id, withdrawable_at_baseline, float_at_baseline,
                                        advance_at_baseline, ledger_net_at_baseline, baseline_at, baseline_reason)
    VALUES (p_user_id, 0, 0, 0, 0, now(), 'Layer A: zeroed at fresh-start anchor');
  END IF;

  UPDATE phantom_wallet_drift
  SET status = 'resolved',
      resolved_at = now(),
      resolved_by = v_caller,
      resolution_notes = 'anchored at zero — historical loss absorbed by company (Layer A)'
  WHERE id = v_phantom.id;

  IF v_writedown_amount > 0 THEN
    v_entries := jsonb_build_array(
      jsonb_build_object(
        'direction','cash_out','amount', v_writedown_amount,
        'category','platform_loss_writeoff','classification','admin_correction',
        'ledger_scope','platform',
        'description', format('Layer A write-down: absorb historical drift for user %s', p_user_id),
        'reference_id', v_phantom.id::text,
        'account','platform_loss'
      ),
      jsonb_build_object(
        'direction','cash_in','amount', v_writedown_amount,
        'category','platform_loss_writeoff','classification','admin_correction',
        'ledger_scope','platform',
        'description', format('Layer A write-down reserve leg for user %s', p_user_id),
        'reference_id', v_phantom.id::text,
        'account','platform_reserve'
      )
    );

    v_tx_id := create_ledger_transaction(
      entries := v_entries,
      idempotency_key := 'layer_a_writedown:' || v_phantom.id::text,
      skip_balance_check := true
    );
  END IF;

  INSERT INTO audit_logs (action_type, table_name, record_id, user_id, action, metadata)
  VALUES (
    'historical_drift_writedown', 'phantom_wallet_drift', v_phantom.id, COALESCE(v_caller, p_user_id),
    'Layer A bulk write-down (CFO-approved historical cohort)',
    jsonb_build_object('user_id', p_user_id, 'writedown_amount', v_writedown_amount,
                       'tx_group_id', v_tx_id, 'invoked_by', current_user,
                       'reason', 'Layer A bulk write-down (CFO-approved historical cohort)')
  );

  INSERT INTO system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'wallet_historical_drift_absorbed'::system_event_type,
    p_user_id,
    'phantom_wallet_drift',
    v_phantom.id,
    jsonb_build_object('amount', v_writedown_amount, 'tx_group_id', v_tx_id, 'source', 'layer_a_bulk')
  );

  RETURN jsonb_build_object(
    'user_id', p_user_id, 'status', 'applied',
    'writedown_amount', v_writedown_amount, 'tx_group_id', v_tx_id, 'phantom_id', v_phantom.id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.apply_layer_a_writedown(uuid, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.run_layer_a_bulk(boolean) TO anon, authenticated, service_role;