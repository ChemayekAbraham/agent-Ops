CREATE OR REPLACE FUNCTION public.detect_phantom_wallet_drift()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_drifted RECORD;
  v_severity text;
  v_drift_type text;
  v_abs numeric;
  v_new_count int := 0;
  v_updated_count int := 0;
  v_auto_resolved int := 0;
  v_total_drift_ugx numeric := 0;
BEGIN
  FOR v_drifted IN
    WITH anchors AS (
      SELECT user_id, anchor_at
      FROM public.wallet_fresh_start_anchors
    ),
    -- Anchor-aware ledger net: mirrors v_user_wallet_strict
    ledger AS (
      SELECT gl.user_id,
             COALESCE(SUM(CASE WHEN gl.direction='cash_in' THEN gl.amount ELSE -gl.amount END), 0) AS net
      FROM public.general_ledger gl
      LEFT JOIN anchors a ON a.user_id = gl.user_id
      WHERE gl.ledger_scope='wallet'
        AND gl.user_id IS NOT NULL
        AND (gl.classification IS NULL OR gl.classification IN ('production','admin_correction'))
        AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
      GROUP BY gl.user_id
    ),
    -- Skip users that had a Layer A/B resolution in the last 30 days
    recently_resolved AS (
      SELECT DISTINCT user_id
      FROM public.phantom_wallet_drift
      WHERE status='resolved'
        AND resolved_at > v_now - interval '30 days'
        AND (resolution_notes ILIKE 'layer_a_%' OR resolution_notes ILIKE 'layer_b_%' OR resolution_notes ILIKE 'stale phantom%')
    )
    SELECT w.user_id,
           w.balance,
           COALESCE(l.net, 0) AS ledger_net,
           w.balance - COALESCE(l.net, 0) AS drift
    FROM public.wallets w
    LEFT JOIN ledger l USING (user_id)
    WHERE w.user_id IS NOT NULL
      AND ABS(w.balance - COALESCE(l.net, 0)) >= 1
      AND w.user_id NOT IN (SELECT user_id FROM recently_resolved)
  LOOP
    v_abs := ABS(v_drifted.drift);
    v_drift_type := CASE WHEN v_drifted.drift > 0 THEN 'positive_phantom' ELSE 'negative_overdebit' END;
    v_severity := CASE
      WHEN v_abs >= 10000000 THEN 'critical'
      WHEN v_abs >= 1000000  THEN 'high'
      WHEN v_abs >= 100000   THEN 'medium'
      ELSE 'low'
    END;
    v_total_drift_ugx := v_total_drift_ugx + v_abs;

    UPDATE public.phantom_wallet_drift
       SET wallet_balance = v_drifted.balance,
           ledger_net = v_drifted.ledger_net,
           drift_amount = v_drifted.drift,
           drift_type = v_drift_type,
           severity = v_severity,
           last_detected_at = v_now,
           detection_run_id = v_run_id,
           updated_at = v_now
     WHERE user_id = v_drifted.user_id
       AND status IN ('open','investigating');

    IF FOUND THEN
      v_updated_count := v_updated_count + 1;
    ELSE
      INSERT INTO public.phantom_wallet_drift
        (user_id, wallet_balance, ledger_net, drift_amount, drift_type,
         severity, status, first_detected_at, last_detected_at, detection_run_id)
      VALUES
        (v_drifted.user_id, v_drifted.balance, v_drifted.ledger_net, v_drifted.drift,
         v_drift_type, v_severity, 'open', v_now, v_now, v_run_id);
      v_new_count := v_new_count + 1;
    END IF;
  END LOOP;

  -- Auto-resolve rows whose users no longer drift under the new anchor-aware comparison
  WITH anchors AS (
    SELECT user_id, anchor_at FROM public.wallet_fresh_start_anchors
  ),
  current_drift AS (
    SELECT pwd.id, pwd.user_id,
           w.balance,
           COALESCE((
             SELECT SUM(CASE WHEN gl.direction='cash_in' THEN gl.amount ELSE -gl.amount END)
             FROM public.general_ledger gl
             LEFT JOIN anchors a ON a.user_id = gl.user_id
             WHERE gl.ledger_scope='wallet'
               AND gl.user_id = pwd.user_id
               AND (gl.classification IS NULL OR gl.classification IN ('production','admin_correction'))
               AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
           ), 0) AS net
    FROM public.phantom_wallet_drift pwd
    JOIN public.wallets w ON w.user_id = pwd.user_id
    WHERE pwd.status IN ('open','investigating')
  )
  UPDATE public.phantom_wallet_drift pwd
     SET status = 'resolved',
         resolved_at = v_now,
         resolution_notes = COALESCE(resolution_notes,'') || E'\nAuto-resolved (anchor-aware): drift cleared at ' || v_now::text,
         updated_at = v_now
    FROM current_drift cd
   WHERE pwd.id = cd.id
     AND ABS(cd.balance - cd.net) < 1;

  GET DIAGNOSTICS v_auto_resolved = ROW_COUNT;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'executed_at', v_now,
    'new_drift_rows', v_new_count,
    'updated_drift_rows', v_updated_count,
    'auto_resolved', v_auto_resolved,
    'total_drift_ugx', v_total_drift_ugx,
    'anchor_aware', true
  );
END;
$function$;