-- Update phantom wallet drift monitor to use strict pivot
-- This will auto-resolve the 73 rows with negative drift caused by the old raw ledger comparison.

CREATE OR REPLACE FUNCTION public.detect_phantom_wallet_drift()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    SELECT w.user_id, w.balance,
           COALESCE(s.total_visible, 0) AS ledger_net,
           w.balance - COALESCE(s.total_visible, 0) AS drift
    FROM public.wallets w
    LEFT JOIN public.v_user_wallet_strict s ON s.user_id = w.user_id
    WHERE ABS(w.balance - COALESCE(s.total_visible, 0)) >= 1
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

  -- Auto-resolve rows whose users no longer drift
  WITH no_longer_drifting AS (
    SELECT pwd.id
    FROM public.phantom_wallet_drift pwd
    JOIN public.wallets w ON w.user_id = pwd.user_id
    LEFT JOIN public.v_user_wallet_strict s ON s.user_id = pwd.user_id
    WHERE pwd.status IN ('open','investigating')
      AND ABS(w.balance - COALESCE(s.total_visible, 0)) < 1
  )
  UPDATE public.phantom_wallet_drift
     SET status = 'resolved',
         resolved_at = v_now,
         resolution_notes = COALESCE(resolution_notes,'') || E'\nAuto-resolved: legacy monitor updated to strict pivot at ' || v_now::text,
         updated_at = v_now
   WHERE id IN (SELECT id FROM no_longer_drifting);

  GET DIAGNOSTICS v_auto_resolved = ROW_COUNT;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'executed_at', v_now,
    'new_drift_rows', v_new_count,
    'updated_drift_rows', v_updated_count,
    'auto_resolved', v_auto_resolved,
    'total_drift_ugx', v_total_drift_ugx
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.detect_phantom_wallet_drift() TO service_role;
