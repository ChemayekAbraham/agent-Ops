-- SMS failure alert configuration (singleton)
CREATE TABLE public.sms_failure_alert_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT true,
  failure_count_threshold INTEGER NOT NULL DEFAULT 5,
  failure_rate_threshold_pct NUMERIC NOT NULL DEFAULT 20,
  min_sample_size INTEGER NOT NULL DEFAULT 10,
  email_enabled BOOLEAN NOT NULL DEFAULT false,
  email_recipients TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_by UUID,
  CONSTRAINT sms_failure_alert_config_singleton CHECK (id = 1)
);

GRANT SELECT, UPDATE ON public.sms_failure_alert_config TO authenticated;
GRANT ALL ON public.sms_failure_alert_config TO service_role;

ALTER TABLE public.sms_failure_alert_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leadership can view SMS alert config"
ON public.sms_failure_alert_config
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Finance leadership can update SMS alert config"
ON public.sms_failure_alert_config
FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'super_admin')
);

INSERT INTO public.sms_failure_alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Daily SMS failure alerts (one open alert per day window)
CREATE TABLE public.sms_failure_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  window_date DATE NOT NULL,
  window_start TIMESTAMP WITH TIME ZONE NOT NULL,
  window_end TIMESTAMP WITH TIME ZONE NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  failure_rate_pct NUMERIC NOT NULL DEFAULT 0,
  severity TEXT NOT NULL DEFAULT 'warning',
  top_failed_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  acknowledged_by UUID,
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  email_sent BOOLEAN NOT NULL DEFAULT false,
  detection_run_id UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_sms_failure_alert_per_day ON public.sms_failure_alerts (window_date);
CREATE INDEX idx_sms_failure_alerts_status ON public.sms_failure_alerts (status, created_at DESC);

GRANT SELECT, UPDATE ON public.sms_failure_alerts TO authenticated;
GRANT ALL ON public.sms_failure_alerts TO service_role;

ALTER TABLE public.sms_failure_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leadership can view SMS failure alerts"
ON public.sms_failure_alerts
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Finance leadership can acknowledge SMS failure alerts"
ON public.sms_failure_alerts
FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'super_admin')
);

-- Detection function: scans last 24h of SMS delivery and raises/refreshes today's alert
CREATE OR REPLACE FUNCTION public.detect_sms_failure_alerts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg public.sms_failure_alert_config%ROWTYPE;
  v_run_id uuid := gen_random_uuid();
  v_window_end timestamptz := now();
  v_window_start timestamptz := now() - interval '24 hours';
  v_window_date date := (now() AT TIME ZONE 'UTC')::date;
  v_total int; v_sent int; v_failed int; v_rate numeric;
  v_triggered boolean := false;
  v_severity text := 'warning';
  v_top jsonb;
  v_alert_id uuid;
BEGIN
  SELECT * INTO v_cfg FROM public.sms_failure_alert_config WHERE id = 1;
  IF v_cfg.id IS NULL OR v_cfg.enabled = false THEN
    RETURN jsonb_build_object('enabled', false, 'triggered', false);
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'sent'),
         count(*) FILTER (WHERE status = 'failed')
  INTO v_total, v_sent, v_failed
  FROM public.sms_delivery_log
  WHERE created_at >= v_window_start AND created_at < v_window_end;

  v_rate := CASE WHEN v_total > 0 THEN round((v_failed::numeric / v_total) * 100, 2) ELSE 0 END;

  v_triggered := v_total >= v_cfg.min_sample_size
    AND (v_failed >= v_cfg.failure_count_threshold OR v_rate >= v_cfg.failure_rate_threshold_pct);

  IF NOT v_triggered THEN
    RETURN jsonb_build_object(
      'enabled', true, 'triggered', false, 'run_id', v_run_id,
      'window_start', v_window_start, 'window_end', v_window_end,
      'total', v_total, 'sent', v_sent, 'failed', v_failed, 'failure_rate_pct', v_rate
    );
  END IF;

  IF v_rate >= 50 OR v_failed >= v_cfg.failure_count_threshold * 3 THEN
    v_severity := 'critical';
  END IF;

  SELECT coalesce(jsonb_agg(t ORDER BY t.failed_count DESC), '[]'::jsonb) INTO v_top
  FROM (
    SELECT coalesce(reference_id, '(no reference)') AS reference,
           coalesce(source, '(unknown)') AS source,
           count(*)::int AS failed_count,
           max(error) AS sample_error,
           max(recipient_phone) AS sample_phone
    FROM public.sms_delivery_log
    WHERE status = 'failed' AND created_at >= v_window_start AND created_at < v_window_end
    GROUP BY coalesce(reference_id, '(no reference)'), coalesce(source, '(unknown)')
    ORDER BY count(*) DESC
    LIMIT 10
  ) t;

  INSERT INTO public.sms_failure_alerts (
    window_date, window_start, window_end, total_count, sent_count, failed_count,
    failure_rate_pct, severity, top_failed_references, detection_run_id
  ) VALUES (
    v_window_date, v_window_start, v_window_end, v_total, v_sent, v_failed,
    v_rate, v_severity, v_top, v_run_id
  )
  ON CONFLICT (window_date) DO UPDATE SET
    window_start = EXCLUDED.window_start,
    window_end = EXCLUDED.window_end,
    total_count = EXCLUDED.total_count,
    sent_count = EXCLUDED.sent_count,
    failed_count = EXCLUDED.failed_count,
    failure_rate_pct = EXCLUDED.failure_rate_pct,
    severity = EXCLUDED.severity,
    top_failed_references = EXCLUDED.top_failed_references,
    detection_run_id = EXCLUDED.detection_run_id
  RETURNING id INTO v_alert_id;

  RETURN jsonb_build_object(
    'enabled', true, 'triggered', true, 'run_id', v_run_id, 'alert_id', v_alert_id,
    'window_start', v_window_start, 'window_end', v_window_end,
    'total', v_total, 'sent', v_sent, 'failed', v_failed,
    'failure_rate_pct', v_rate, 'severity', v_severity,
    'top_failed_references', v_top,
    'email_enabled', v_cfg.email_enabled, 'email_recipients', v_cfg.email_recipients
  );
END;
$$;

REVOKE ALL ON FUNCTION public.detect_sms_failure_alerts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_sms_failure_alerts() TO authenticated, service_role;