
-- Guardrail alert config + detector

CREATE TABLE IF NOT EXISTS public.deposit_guardrail_alert_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  threshold_count integer NOT NULL DEFAULT 5,
  window_minutes integer NOT NULL DEFAULT 15,
  severity text NOT NULL DEFAULT 'high',
  enabled boolean NOT NULL DEFAULT true,
  cooldown_minutes integer NOT NULL DEFAULT 30,
  last_alert_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.deposit_guardrail_alert_config (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.deposit_guardrail_alert_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers view guardrail alert config"
  ON public.deposit_guardrail_alert_config FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(),'manager'::app_role)
    OR has_role(auth.uid(),'ceo'::app_role)
    OR has_role(auth.uid(),'cfo'::app_role)
    OR has_role(auth.uid(),'coo'::app_role)
  );

CREATE POLICY "Managers update guardrail alert config"
  ON public.deposit_guardrail_alert_config FOR UPDATE TO authenticated
  USING (has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'cfo'::app_role))
  WITH CHECK (has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'cfo'::app_role));

-- Detection function: counts blocked-or-reverted guardrail audit rows in the
-- configured window, raises an alert when threshold exceeded (respecting cooldown).
CREATE OR REPLACE FUNCTION public.detect_deposit_guardrail_alerts()
RETURNS TABLE(alert_id uuid, block_count bigint, threshold integer, window_minutes integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg public.deposit_guardrail_alert_config%ROWTYPE;
  v_count bigint;
  v_alert_id uuid;
  v_window_start timestamptz;
  v_sources jsonb;
BEGIN
  SELECT * INTO v_cfg FROM public.deposit_guardrail_alert_config WHERE id = true;
  IF NOT FOUND OR NOT v_cfg.enabled THEN
    RETURN;
  END IF;

  v_window_start := now() - make_interval(mins => v_cfg.window_minutes);

  SELECT count(*) INTO v_count
  FROM public.deposit_guardrail_audit
  WHERE created_at >= v_window_start
    AND action IN ('blocked','reverted');

  IF v_count < v_cfg.threshold_count THEN
    RETURN;
  END IF;

  -- Cooldown: skip if we already alerted recently
  IF v_cfg.last_alert_at IS NOT NULL
     AND v_cfg.last_alert_at > now() - make_interval(mins => v_cfg.cooldown_minutes) THEN
    RETURN;
  END IF;

  SELECT jsonb_object_agg(source, cnt) INTO v_sources
  FROM (
    SELECT coalesce(source,'unknown') AS source, count(*) AS cnt
    FROM public.deposit_guardrail_audit
    WHERE created_at >= v_window_start
      AND action IN ('blocked','reverted')
    GROUP BY 1
  ) s;

  INSERT INTO public.cfo_threshold_alerts (
    alert_type, severity, title, description, threshold_value, current_value
  ) VALUES (
    'deposit_guardrail_burst',
    v_cfg.severity,
    format('Deposit guardrail blocked %s auto-deposits in %s min', v_count, v_cfg.window_minutes),
    format(
      'Guardrail blocked/reverted %s auto-created deposits (threshold %s) in the last %s minutes. Sources: %s',
      v_count, v_cfg.threshold_count, v_cfg.window_minutes, coalesce(v_sources::text,'{}')
    ),
    v_cfg.threshold_count,
    v_count
  ) RETURNING id INTO v_alert_id;

  UPDATE public.deposit_guardrail_alert_config
     SET last_alert_at = now(), updated_at = now()
   WHERE id = true;

  -- Emit system event (best-effort; ignore if table absent)
  BEGIN
    INSERT INTO public.system_events (event_type, payload, severity)
    VALUES (
      'deposit.guardrail.alert_raised',
      jsonb_build_object(
        'alert_id', v_alert_id,
        'count', v_count,
        'threshold', v_cfg.threshold_count,
        'window_minutes', v_cfg.window_minutes,
        'sources', coalesce(v_sources,'{}'::jsonb)
      ),
      v_cfg.severity
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
  END;

  RETURN QUERY SELECT v_alert_id, v_count, v_cfg.threshold_count, v_cfg.window_minutes;
END;
$$;

REVOKE ALL ON FUNCTION public.detect_deposit_guardrail_alerts() FROM public;
GRANT EXECUTE ON FUNCTION public.detect_deposit_guardrail_alerts() TO authenticated, service_role;

-- Schedule every 5 minutes (pg_cron). Ignore failure if extension or job exists.
DO $$
BEGIN
  PERFORM cron.unschedule('detect-deposit-guardrail-alerts');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.schedule(
    'detect-deposit-guardrail-alerts',
    '*/5 * * * *',
    $cron$ SELECT public.detect_deposit_guardrail_alerts(); $cron$
  );
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
