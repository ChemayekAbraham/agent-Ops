
-- Relax role gate: allow service_role / superuser (Cloud SQL editor) OR cfo/manager
CREATE OR REPLACE FUNCTION public.apply_layer_a_writedown(p_user_id uuid, p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  -- Allow: (a) cfo/manager via auth, OR (b) service_role / superuser (Cloud SQL editor / cron)
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
  ORDER BY detected_at DESC
  LIMIT 1;

  IF v_phantom IS NULL THEN
    RETURN jsonb_build_object('user_id', p_user_id, 'status', 'skipped', 'reason', 'no_open_negative_overdebit_row');
  END IF;

  SELECT COALESCE(SUM(CASE WHEN entry_type='cash_in' THEN amount ELSE -amount END), 0)
  INTO v_strict_net
  FROM general_ledger
  WHERE user_id = p_user_id
    AND classification IN ('production','admin_correction');

  SELECT COALESCE(SUM(amount), 0)
  INTO v_post_apr_credits
  FROM general_ledger
  WHERE user_id = p_user_id
    AND entry_type = 'cash_in'
    AND classification = 'production'
    AND created_at >= '2026-04-01'
    AND category NOT IN ('system_balance_correction','agent_float_topup','agent_float_recovery',
                         'advance_repayment','advance_disbursement','historical_balance_reseed',
                         'platform_loss_writeoff');

  IF v_post_apr_credits > 0 AND v_strict_net > 0 THEN
    RETURN jsonb_build_object(
      'user_id', p_user_id, 'status', 'blocked',
      'reason', 'user_has_unspent_post_apr_credits',
      'strict_net', v_strict_net, 'post_apr_credits', v_post_apr_credits
    );
  END IF;

  v_writedown_amount := ABS(v_strict_net);

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'user_id', p_user_id, 'status', 'would_apply',
      'strict_net', v_strict_net, 'writedown_amount', v_writedown_amount,
      'phantom_id', v_phantom.id
    );
  END IF;

  SELECT EXISTS(SELECT 1 FROM wallet_fresh_start_anchors WHERE user_id = p_user_id) INTO v_anchor_exists;
  IF NOT v_anchor_exists THEN
    INSERT INTO wallet_fresh_start_anchors (user_id, anchored_at, reason)
    VALUES (p_user_id, now(), 'layer_a_historical_drift_writedown');
  END IF;

  SELECT EXISTS(SELECT 1 FROM wallet_ledger_baseline WHERE user_id = p_user_id) INTO v_baseline_exists;
  IF v_baseline_exists THEN
    UPDATE wallet_ledger_baseline
    SET baseline_amount = 0, snapshot_at = now(), notes = 'Layer A: zeroed at fresh-start anchor'
    WHERE user_id = p_user_id;
  ELSE
    INSERT INTO wallet_ledger_baseline (user_id, baseline_amount, snapshot_at, notes)
    VALUES (p_user_id, 0, now(), 'Layer A: zeroed at fresh-start anchor');
  END IF;

  UPDATE phantom_wallet_drift
  SET status = 'resolved',
      resolved_at = now(),
      resolution_notes = 'anchored at zero — historical loss absorbed by company (Layer A)'
  WHERE id = v_phantom.id;

  IF v_writedown_amount > 0 THEN
    v_entries := jsonb_build_array(
      jsonb_build_object(
        'entry_type','cash_out','amount', v_writedown_amount,
        'category','platform_loss_writeoff','classification','admin_correction',
        'description', format('Layer A write-down: absorb historical drift for user %s', p_user_id),
        'metadata', jsonb_build_object('layer','A','phantom_id', v_phantom.id, 'user_id', p_user_id)
      ),
      jsonb_build_object(
        'entry_type','cash_in','amount', v_writedown_amount,
        'category','platform_loss_writeoff','classification','admin_correction',
        'description', format('Layer A write-down reserve leg for user %s', p_user_id),
        'metadata', jsonb_build_object('layer','A','phantom_id', v_phantom.id, 'user_id', p_user_id, 'leg','reserve')
      )
    );

    SELECT (create_ledger_transaction(
      p_transaction_type := 'historical_loss_writedown',
      p_entries := v_entries,
      p_skip_balance_check := true
    ))->>'transaction_id' INTO v_tx_id;
  END IF;

  INSERT INTO audit_logs (action_type, table_name, record_id, performed_by, reason, metadata)
  VALUES (
    'historical_drift_writedown', 'phantom_wallet_drift', v_phantom.id, COALESCE(v_caller, p_user_id),
    'Layer A bulk write-down (CFO-approved historical cohort)',
    jsonb_build_object('user_id', p_user_id, 'writedown_amount', v_writedown_amount, 'tx_id', v_tx_id, 'invoked_by', current_user)
  );

  PERFORM emit_system_event(
    'wallet.historical_drift.absorbed',
    jsonb_build_object('user_id', p_user_id, 'amount', v_writedown_amount, 'phantom_id', v_phantom.id)
  );

  RETURN jsonb_build_object(
    'user_id', p_user_id, 'status', 'applied',
    'writedown_amount', v_writedown_amount, 'tx_id', v_tx_id, 'phantom_id', v_phantom.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.run_layer_a_bulk(p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_privileged boolean := false;
  r record;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_applied int := 0; v_blocked int := 0; v_skipped int := 0; v_would int := 0;
  v_total_writedown numeric := 0;
BEGIN
  IF v_caller IS NOT NULL THEN
    v_is_privileged := has_role(v_caller, 'cfo'::app_role) OR has_role(v_caller, 'manager'::app_role);
  ELSE
    v_is_privileged := (current_user IN ('service_role','postgres','supabase_admin'))
                       OR pg_has_role(current_user, 'service_role', 'MEMBER');
  END IF;

  IF NOT v_is_privileged THEN
    RAISE EXCEPTION 'Only CFO, Manager, or service role may run Layer A bulk';
  END IF;

  FOR r IN
    SELECT DISTINCT user_id
    FROM phantom_wallet_drift
    WHERE status = 'open' AND drift_type = 'negative_overdebit'
  LOOP
    v_result := apply_layer_a_writedown(r.user_id, p_dry_run);
    v_results := v_results || v_result;

    CASE v_result->>'status'
      WHEN 'applied' THEN
        v_applied := v_applied + 1;
        v_total_writedown := v_total_writedown + COALESCE((v_result->>'writedown_amount')::numeric, 0);
      WHEN 'would_apply' THEN
        v_would := v_would + 1;
        v_total_writedown := v_total_writedown + COALESCE((v_result->>'writedown_amount')::numeric, 0);
      WHEN 'blocked' THEN v_blocked := v_blocked + 1;
      ELSE v_skipped := v_skipped + 1;
    END CASE;
  END LOOP;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run,
    'applied', v_applied, 'would_apply', v_would, 'blocked', v_blocked, 'skipped', v_skipped,
    'total_writedown_ugx', v_total_writedown,
    'invoked_by', current_user,
    'details', v_results
  );
END;
$$;
