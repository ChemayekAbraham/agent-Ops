
-- =====================================================================
-- Layer A: Historical Wallet Drift Writedown
-- =====================================================================

CREATE OR REPLACE FUNCTION public.apply_layer_a_writedown(
  p_user_id uuid,
  p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phantom        public.phantom_wallet_drift%ROWTYPE;
  v_drift_abs      numeric;
  v_strict_net     numeric;
  v_recent_credits numeric;
  v_ledger_id      uuid;
  v_event_id       uuid;
  v_reason         text;
  v_actor          uuid := auth.uid();
BEGIN
  IF NOT (public.has_role(v_actor, 'cfo'::app_role)
          OR public.has_role(v_actor, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager may run Layer A writedown';
  END IF;

  -- Locate the open negative-overdebit phantom row for this user.
  SELECT * INTO v_phantom
  FROM public.phantom_wallet_drift
  WHERE user_id = p_user_id
    AND status IN ('open','investigating')
    AND drift_type = 'negative_overdebit'
  ORDER BY last_detected_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status','skipped',
      'reason','no_open_negative_overdebit_phantom',
      'user_id', p_user_id
    );
  END IF;

  v_drift_abs := abs(v_phantom.drift_amount);

  -- Compute the user's current strict ledger net (production + admin_correction).
  SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END),0)
  INTO v_strict_net
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND classification IN ('production','admin_correction');

  -- Safety belt: refuse if the user has *unspent* wallet cash_in legs since Apr 1
  -- (we don't want to lock in a legitimate recent credit by anchoring).
  -- We compare per-bucket cash_in vs cash_out for the post-Apr-01 window.
  SELECT COALESCE(SUM(
    CASE WHEN direction='cash_in' THEN amount
         WHEN direction='cash_out' THEN -amount
         ELSE 0 END), 0)
  INTO v_recent_credits
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND classification = 'production'
    AND created_at >= '2026-04-01'::timestamptz
    AND COALESCE(category,'') NOT IN (
      'system_balance_correction',
      'agent_float_deposit','agent_float_used_for_rent',
      'agent_float_settlement','agent_float_assignment',
      'rent_float_funding','partner_funding','test_funds_cleanup',
      'historical_balance_reseed'
    )
    AND COALESCE(category,'') NOT LIKE 'advance_%';

  IF v_recent_credits > 0 THEN
    RETURN jsonb_build_object(
      'status','blocked',
      'reason','user has unspent post-Apr-01 wallet credits — manual review required',
      'user_id', p_user_id,
      'recent_net_credits', v_recent_credits,
      'phantom_drift', v_phantom.drift_amount
    );
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'status','dry_run_ok',
      'user_id', p_user_id,
      'phantom_drift', v_phantom.drift_amount,
      'strict_ledger_net', v_strict_net,
      'will_post_writedown_amount', v_drift_abs,
      'will_anchor_at', now(),
      'will_resolve_phantom_id', v_phantom.id
    );
  END IF;

  v_reason := format(
    'Layer A historical drift writedown — anchored at zero, %s UGX absorbed by company P&L',
    to_char(v_drift_abs, 'FM999,999,999,999')
  );

  -- 1. Fresh-start anchor (idempotent: keep earliest if already exists).
  INSERT INTO public.wallet_fresh_start_anchors (
    user_id, anchor_at, pre_anchor_ledger_net, reason, created_by, notes
  ) VALUES (
    p_user_id, now(), v_strict_net,
    'layer_a_historical_writedown',
    v_actor,
    v_reason
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- 2. Zero baseline snapshot.
  INSERT INTO public.wallet_ledger_baseline (
    user_id, withdrawable_at_baseline, float_at_baseline, advance_at_baseline,
    ledger_net_at_baseline, baseline_at, baseline_reason
  ) VALUES (
    p_user_id, 0, 0, 0, 0, now(), 'layer_a_writedown_2026_05_07'
  )
  ON CONFLICT (user_id) DO UPDATE SET
    withdrawable_at_baseline = 0,
    float_at_baseline        = 0,
    advance_at_baseline      = 0,
    ledger_net_at_baseline   = 0,
    baseline_at              = now(),
    baseline_reason          = 'layer_a_writedown_2026_05_07';

  -- 3. Platform-only balanced writedown (Loss expense ↔ Reserve offset).
  --    Wallet scope is intentionally NOT touched: the anchor seals the past.
  IF v_drift_abs > 0 THEN
    v_ledger_id := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', NULL,
          'ledger_scope', 'platform',
          'direction', 'cash_out',
          'amount', v_drift_abs,
          'category', 'platform_loss_writeoff',
          'classification', 'admin_correction',
          'description', 'Layer A historical drift writedown (loss leg) — user ' || p_user_id::text
        ),
        jsonb_build_object(
          'user_id', NULL,
          'ledger_scope', 'platform',
          'direction', 'cash_in',
          'amount', v_drift_abs,
          'category', 'platform_loss_writeoff',
          'classification', 'admin_correction',
          'description', 'Layer A historical drift writedown (reserve offset) — user ' || p_user_id::text
        )
      ),
      idempotency_key := 'layer_a_writedown:' || p_user_id::text,
      skip_balance_check := true
    );
  END IF;

  -- 4. Resolve the phantom row.
  UPDATE public.phantom_wallet_drift
     SET status = 'resolved',
         resolved_at = now(),
         resolved_by = v_actor,
         resolution_notes = 'anchored at zero — historical loss absorbed by company (Layer A)',
         updated_at = now()
   WHERE id = v_phantom.id;

  -- 5. Audit + system_event.
  INSERT INTO public.audit_logs (action_type, table_name, record_id, actor_id, reason, metadata)
  VALUES (
    'historical_drift_writedown',
    'phantom_wallet_drift',
    v_phantom.id,
    v_actor,
    v_reason,
    jsonb_build_object(
      'user_id', p_user_id,
      'drift_amount', v_phantom.drift_amount,
      'strict_ledger_net', v_strict_net,
      'platform_writedown_ledger_id', v_ledger_id
    )
  );

  BEGIN
    INSERT INTO public.system_events (event_type, payload, source)
    VALUES (
      'wallet.historical_drift.absorbed',
      jsonb_build_object(
        'user_id', p_user_id,
        'amount_absorbed_ugx', v_drift_abs,
        'phantom_id', v_phantom.id,
        'ledger_id', v_ledger_id,
        'method', 'layer_a_anchor_plus_platform_writedown'
      ),
      'apply_layer_a_writedown'
    )
    RETURNING id INTO v_event_id;
  EXCEPTION WHEN OTHERS THEN v_event_id := NULL;
  END;

  RETURN jsonb_build_object(
    'status','applied',
    'user_id', p_user_id,
    'amount_absorbed_ugx', v_drift_abs,
    'platform_writedown_ledger_id', v_ledger_id,
    'phantom_resolved_id', v_phantom.id,
    'event_id', v_event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_layer_a_writedown(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_layer_a_writedown(uuid, boolean) TO authenticated;

-- =====================================================================
-- Bulk runner — loops every open negative_overdebit user.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.run_layer_a_bulk(p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id  uuid;
  v_result   jsonb;
  v_results  jsonb := '[]'::jsonb;
  v_applied  int := 0;
  v_blocked  int := 0;
  v_skipped  int := 0;
  v_total_absorbed numeric := 0;
  v_actor    uuid := auth.uid();
BEGIN
  IF NOT (public.has_role(v_actor, 'cfo'::app_role)
          OR public.has_role(v_actor, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager may run Layer A bulk';
  END IF;

  FOR v_user_id IN
    SELECT DISTINCT user_id
    FROM public.phantom_wallet_drift
    WHERE status IN ('open','investigating')
      AND drift_type = 'negative_overdebit'
    ORDER BY 1
  LOOP
    BEGIN
      v_result := public.apply_layer_a_writedown(v_user_id, p_dry_run);
      v_results := v_results || jsonb_build_array(v_result);

      IF v_result->>'status' IN ('applied','dry_run_ok') THEN
        v_applied := v_applied + 1;
        v_total_absorbed := v_total_absorbed
          + COALESCE((v_result->>'amount_absorbed_ugx')::numeric,
                     (v_result->>'will_post_writedown_amount')::numeric, 0);
      ELSIF v_result->>'status' = 'blocked' THEN
        v_blocked := v_blocked + 1;
      ELSE
        v_skipped := v_skipped + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'status','error',
        'user_id', v_user_id,
        'error', SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'mode', CASE WHEN p_dry_run THEN 'dry_run' ELSE 'applied' END,
    'applied_or_planned', v_applied,
    'blocked', v_blocked,
    'skipped', v_skipped,
    'total_absorbed_ugx', v_total_absorbed,
    'details', v_results
  );
END;
$$;

REVOKE ALL ON FUNCTION public.run_layer_a_bulk(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_layer_a_bulk(boolean) TO authenticated;
