-- 1. Threshold config (single row)
CREATE TABLE IF NOT EXISTS public.wallet_drift_alert_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true,
  low_threshold_ugx numeric NOT NULL DEFAULT 50000,
  medium_threshold_ugx numeric NOT NULL DEFAULT 250000,
  high_threshold_ugx numeric NOT NULL DEFAULT 1000000,
  critical_threshold_ugx numeric NOT NULL DEFAULT 10000000,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_drift_alert_config_singleton_unique UNIQUE (singleton)
);

INSERT INTO public.wallet_drift_alert_config (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.wallet_drift_alert_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CFO and Manager can view drift alert config"
ON public.wallet_drift_alert_config FOR SELECT
USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager'));

CREATE POLICY "CFO and Manager can update drift alert config"
ON public.wallet_drift_alert_config FOR UPDATE
USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager'));

-- 2. Alerts table
CREATE TABLE IF NOT EXISTS public.wallet_withdrawable_drift_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  withdrawable_cached numeric NOT NULL,
  expected_withdrawable numeric NOT NULL,
  baseline_withdrawable numeric NOT NULL,
  baseline_ledger_net numeric NOT NULL,
  ledger_net_now numeric NOT NULL,
  deviation_amount numeric NOT NULL,
  deviation_direction text NOT NULL CHECK (deviation_direction IN ('overstated','understated')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','false_positive')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_notes text,
  detection_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_withdrawable_drift_alerts_one_open_per_user
  ON public.wallet_withdrawable_drift_alerts (user_id)
  WHERE status IN ('open','investigating');

CREATE INDEX IF NOT EXISTS wallet_withdrawable_drift_alerts_status_severity_idx
  ON public.wallet_withdrawable_drift_alerts (status, severity, last_detected_at DESC);

ALTER TABLE public.wallet_withdrawable_drift_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CFO and Manager can view drift alerts"
ON public.wallet_withdrawable_drift_alerts FOR SELECT
USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager'));

CREATE POLICY "CFO and Manager can update drift alerts"
ON public.wallet_withdrawable_drift_alerts FOR UPDATE
USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager'));

-- 3. Detector RPC
CREATE OR REPLACE FUNCTION public.detect_withdrawable_drift_alerts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_cfg RECORD;
  v_row RECORD;
  v_severity text;
  v_direction text;
  v_abs numeric;
  v_expected numeric;
  v_deviation numeric;
  v_new_count int := 0;
  v_updated_count int := 0;
  v_auto_resolved int := 0;
  v_total_dev numeric := 0;
  v_was_existing boolean;
BEGIN
  SELECT * INTO v_cfg FROM public.wallet_drift_alert_config LIMIT 1;
  IF v_cfg IS NULL OR v_cfg.enabled = false THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'detector_disabled');
  END IF;

  FOR v_row IN
    WITH ledger AS (
      SELECT user_id,
        COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END), 0) AS net
      FROM public.general_ledger
      WHERE ledger_scope='wallet' AND user_id IS NOT NULL
        AND classification IN ('production','admin_correction')
      GROUP BY user_id
    )
    SELECT b.user_id,
           b.withdrawable_at_baseline AS baseline_w,
           b.ledger_net_at_baseline AS baseline_net,
           COALESCE(l.net, 0) AS ledger_net_now,
           COALESCE(w.withdrawable_balance, 0) AS withdrawable_cached
    FROM public.wallet_ledger_baseline b
    LEFT JOIN ledger l ON l.user_id = b.user_id
    LEFT JOIN public.wallets w ON w.user_id = b.user_id
  LOOP
    v_expected := GREATEST(0, v_row.baseline_w + (v_row.ledger_net_now - v_row.baseline_net));
    v_deviation := v_row.withdrawable_cached - v_expected;
    v_abs := ABS(v_deviation);

    IF v_abs >= v_cfg.low_threshold_ugx THEN
      v_direction := CASE WHEN v_deviation > 0 THEN 'overstated' ELSE 'understated' END;
      v_severity := CASE
        WHEN v_abs >= v_cfg.critical_threshold_ugx THEN 'critical'
        WHEN v_abs >= v_cfg.high_threshold_ugx THEN 'high'
        WHEN v_abs >= v_cfg.medium_threshold_ugx THEN 'medium'
        ELSE 'low'
      END;
      v_total_dev := v_total_dev + v_abs;

      UPDATE public.wallet_withdrawable_drift_alerts
         SET withdrawable_cached = v_row.withdrawable_cached,
             expected_withdrawable = v_expected,
             baseline_withdrawable = v_row.baseline_w,
             baseline_ledger_net = v_row.baseline_net,
             ledger_net_now = v_row.ledger_net_now,
             deviation_amount = v_deviation,
             deviation_direction = v_direction,
             severity = v_severity,
             last_detected_at = v_now,
             detection_run_id = v_run_id,
             updated_at = v_now
       WHERE user_id = v_row.user_id
         AND status IN ('open','investigating');

      GET DIAGNOSTICS v_was_existing = ROW_COUNT;

      IF v_was_existing THEN
        v_updated_count := v_updated_count + 1;
      ELSE
        INSERT INTO public.wallet_withdrawable_drift_alerts
          (user_id, withdrawable_cached, expected_withdrawable, baseline_withdrawable,
           baseline_ledger_net, ledger_net_now, deviation_amount, deviation_direction,
           severity, status, first_detected_at, last_detected_at, detection_run_id)
        VALUES
          (v_row.user_id, v_row.withdrawable_cached, v_expected, v_row.baseline_w,
           v_row.baseline_net, v_row.ledger_net_now, v_deviation, v_direction,
           v_severity, 'open', v_now, v_now, v_run_id);
        v_new_count := v_new_count + 1;

        IF v_severity IN ('high','critical') THEN
          INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
          VALUES ('wallet.drift_alert.raised', v_row.user_id, 'wallet_withdrawable_drift_alerts', v_row.user_id,
            jsonb_build_object(
              'severity', v_severity,
              'direction', v_direction,
              'deviation_ugx', v_abs,
              'cached', v_row.withdrawable_cached,
              'expected', v_expected,
              'run_id', v_run_id
            ));
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Auto-resolve alerts that have fallen back below threshold
  WITH cleared AS (
    SELECT a.id
    FROM public.wallet_withdrawable_drift_alerts a
    JOIN public.wallet_ledger_baseline b ON b.user_id = a.user_id
    LEFT JOIN public.wallets w ON w.user_id = a.user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END), 0) AS net
      FROM public.general_ledger
      WHERE ledger_scope='wallet' AND user_id = a.user_id
        AND classification IN ('production','admin_correction')
    ) l ON TRUE
    WHERE a.status IN ('open','investigating')
      AND ABS(COALESCE(w.withdrawable_balance,0) - GREATEST(0, b.withdrawable_at_baseline + (COALESCE(l.net,0) - b.ledger_net_at_baseline))) < v_cfg.low_threshold_ugx
  )
  UPDATE public.wallet_withdrawable_drift_alerts
     SET status = 'resolved',
         resolved_at = v_now,
         resolution_notes = COALESCE(resolution_notes,'') || E'\nAuto-resolved: deviation cleared at ' || v_now::text,
         updated_at = v_now
   WHERE id IN (SELECT id FROM cleared);

  GET DIAGNOSTICS v_auto_resolved = ROW_COUNT;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'executed_at', v_now,
    'new_alerts', v_new_count,
    'updated_alerts', v_updated_count,
    'auto_resolved', v_auto_resolved,
    'total_deviation_ugx', v_total_dev,
    'thresholds', jsonb_build_object(
      'low', v_cfg.low_threshold_ugx,
      'medium', v_cfg.medium_threshold_ugx,
      'high', v_cfg.high_threshold_ugx,
      'critical', v_cfg.critical_threshold_ugx
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.detect_withdrawable_drift_alerts() TO authenticated, service_role;