-- detect_sms_failure_alerts counted every sms_delivery_log row, including the
-- intermediate attempts of a message that a later provider then delivered
-- (e.g. Yoola accepted-but-unconfirmed, rescued by Africa's Talking). Those
-- customers DID get their SMS. Over the 7 days to 2026-10-08 that inflated
-- failures from 622 to 953 (+53%), so the daily alert could fire on messages
-- that were in fact delivered.
--
-- Same rule the Board memo (get_board_tech_memo) and get_cto_daily_report
-- already use: one row per logical message = drop rows whose attempt_sequence
-- is below total_attempts (a later attempt exists and carries the outcome).

CREATE OR REPLACE FUNCTION public.detect_sms_failure_alerts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  WHERE created_at >= v_window_start AND created_at < v_window_end
    AND NOT (provider_response ? 'total_attempts'
             AND (provider_response->>'attempt_sequence')::int < (provider_response->>'total_attempts')::int);

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
      AND NOT (provider_response ? 'total_attempts'
               AND (provider_response->>'attempt_sequence')::int < (provider_response->>'total_attempts')::int)
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
$function$;
