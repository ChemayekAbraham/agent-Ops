CREATE OR REPLACE FUNCTION public.detect_sms_verification_failures()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg public.sms_verification_alert_config%ROWTYPE;
  v_window_end timestamptz := now();
  v_window_start timestamptz;
  v_bucket timestamptz := date_trunc('hour', now());
  v_raised int := 0;
  rec record;
  v_total int; v_matched int; v_rate numeric; v_severity text; v_codes jsonb; v_label text;
BEGIN
  SELECT * INTO v_cfg FROM public.sms_verification_alert_config WHERE id = 1;
  IF v_cfg.id IS NULL OR v_cfg.enabled = false THEN
    RETURN jsonb_build_object('enabled', false, 'raised', 0);
  END IF;

  v_window_start := now() - make_interval(mins => v_cfg.window_minutes);

  -- ---- By approver (merchant submitting the SMS) --------------------------
  FOR rec IN
    SELECT approver_id, count(*)::int AS failed
    FROM public.payout_claim_sms_audit_log
    WHERE validation_result = 'mismatch'
      AND approver_id IS NOT NULL
      AND created_at >= v_window_start AND created_at < v_window_end
    GROUP BY approver_id
    HAVING count(*) >= v_cfg.failure_count_threshold
  LOOP
    SELECT count(*)::int, count(*) FILTER (WHERE validation_result = 'matched')::int
      INTO v_total, v_matched
    FROM public.payout_claim_sms_audit_log
    WHERE approver_id = rec.approver_id
      AND created_at >= v_window_start AND created_at < v_window_end;

    IF v_total < v_cfg.min_attempts THEN CONTINUE; END IF;

    v_rate := round((rec.failed::numeric / GREATEST(v_total, 1)) * 100, 2);
    v_severity := CASE
      WHEN rec.failed >= v_cfg.failure_count_threshold * 3 THEN 'critical'
      WHEN rec.failed >= v_cfg.failure_count_threshold * 2 THEN 'high'
      ELSE 'warning' END;

    SELECT coalesce(jsonb_agg(c ORDER BY c.n DESC), '[]'::jsonb) INTO v_codes
    FROM (
      SELECT coalesce(validation_code, 'unknown') AS code, count(*)::int AS n
      FROM public.payout_claim_sms_audit_log
      WHERE approver_id = rec.approver_id AND validation_result = 'mismatch'
        AND created_at >= v_window_start AND created_at < v_window_end
      GROUP BY coalesce(validation_code, 'unknown') ORDER BY count(*) DESC LIMIT 5
    ) c;

    SELECT coalesce(email, full_name, approver_id::text) INTO v_label
    FROM public.profiles WHERE id = rec.approver_id;
    v_label := coalesce(v_label, rec.approver_id::text);

    INSERT INTO public.sms_verification_failure_alerts (
      subject_type, subject_id, subject_label, dedup_bucket, window_start, window_end,
      total_attempts, failed_count, matched_count, failure_rate_pct, top_failure_codes, severity
    ) VALUES (
      'approver', rec.approver_id, v_label, v_bucket, v_window_start, v_window_end,
      v_total, rec.failed, v_matched, v_rate, v_codes, v_severity
    )
    ON CONFLICT (subject_type, subject_id, dedup_bucket) DO UPDATE SET
      window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
      total_attempts = EXCLUDED.total_attempts, failed_count = EXCLUDED.failed_count,
      matched_count = EXCLUDED.matched_count, failure_rate_pct = EXCLUDED.failure_rate_pct,
      top_failure_codes = EXCLUDED.top_failure_codes, severity = EXCLUDED.severity,
      subject_label = EXCLUDED.subject_label;

    v_raised := v_raised + 1;

    IF v_severity IN ('high', 'critical') THEN
      INSERT INTO public.system_events (event_type, related_entity_type, related_entity_id, metadata)
      VALUES ('sms.verification_failure_alert.raised', 'approver', rec.approver_id, jsonb_build_object(
        'subject_type', 'approver', 'subject_id', rec.approver_id, 'subject_label', v_label,
        'failed_count', rec.failed, 'total_attempts', v_total, 'failure_rate_pct', v_rate,
        'severity', v_severity));
    END IF;
  END LOOP;

  -- ---- By withdrawal request ---------------------------------------------
  FOR rec IN
    SELECT withdrawal_request_id, count(*)::int AS failed
    FROM public.payout_claim_sms_audit_log
    WHERE validation_result = 'mismatch'
      AND withdrawal_request_id IS NOT NULL
      AND created_at >= v_window_start AND created_at < v_window_end
    GROUP BY withdrawal_request_id
    HAVING count(*) >= v_cfg.failure_count_threshold
  LOOP
    SELECT count(*)::int, count(*) FILTER (WHERE validation_result = 'matched')::int
      INTO v_total, v_matched
    FROM public.payout_claim_sms_audit_log
    WHERE withdrawal_request_id = rec.withdrawal_request_id
      AND created_at >= v_window_start AND created_at < v_window_end;

    v_rate := round((rec.failed::numeric / GREATEST(v_total, 1)) * 100, 2);
    v_severity := CASE
      WHEN rec.failed >= v_cfg.failure_count_threshold * 3 THEN 'critical'
      WHEN rec.failed >= v_cfg.failure_count_threshold * 2 THEN 'high'
      ELSE 'warning' END;

    SELECT coalesce(jsonb_agg(c ORDER BY c.n DESC), '[]'::jsonb) INTO v_codes
    FROM (
      SELECT coalesce(validation_code, 'unknown') AS code, count(*)::int AS n
      FROM public.payout_claim_sms_audit_log
      WHERE withdrawal_request_id = rec.withdrawal_request_id AND validation_result = 'mismatch'
        AND created_at >= v_window_start AND created_at < v_window_end
      GROUP BY coalesce(validation_code, 'unknown') ORDER BY count(*) DESC LIMIT 5
    ) c;

    INSERT INTO public.sms_verification_failure_alerts (
      subject_type, subject_id, subject_label, dedup_bucket, window_start, window_end,
      total_attempts, failed_count, matched_count, failure_rate_pct, top_failure_codes, severity
    ) VALUES (
      'withdrawal', rec.withdrawal_request_id, rec.withdrawal_request_id::text, v_bucket,
      v_window_start, v_window_end, v_total, rec.failed, v_matched, v_rate, v_codes, v_severity
    )
    ON CONFLICT (subject_type, subject_id, dedup_bucket) DO UPDATE SET
      window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
      total_attempts = EXCLUDED.total_attempts, failed_count = EXCLUDED.failed_count,
      matched_count = EXCLUDED.matched_count, failure_rate_pct = EXCLUDED.failure_rate_pct,
      top_failure_codes = EXCLUDED.top_failure_codes, severity = EXCLUDED.severity;

    v_raised := v_raised + 1;

    IF v_severity IN ('high', 'critical') THEN
      INSERT INTO public.system_events (event_type, related_entity_type, related_entity_id, metadata)
      VALUES ('sms.verification_failure_alert.raised', 'withdrawal', rec.withdrawal_request_id, jsonb_build_object(
        'subject_type', 'withdrawal', 'subject_id', rec.withdrawal_request_id,
        'failed_count', rec.failed, 'total_attempts', v_total, 'failure_rate_pct', v_rate,
        'severity', v_severity));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('enabled', true, 'raised', v_raised,
    'window_start', v_window_start, 'window_end', v_window_end);
END;
$function$;