CREATE OR REPLACE FUNCTION public.run_payout_acceptance_scan(
  p_trigger_source text DEFAULT 'manual',
  p_window_days integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rows jsonb;
  v_fail integer := 0;
  v_warn integer := 0;
  v_total integer := 0;
  v_enabled boolean := true;
BEGIN
  SELECT COALESCE(enabled, true) INTO v_enabled
  FROM public.finance_anomaly_alert_config WHERE id = 1;

  CREATE TEMP TABLE IF NOT EXISTS _acc_tmp (
    check_key text, title text, status text,
    observed numeric, expected numeric, detail text
  ) ON COMMIT DROP;
  EXECUTE 'TRUNCATE TABLE _acc_tmp';
  INSERT INTO _acc_tmp
  SELECT * FROM public.run_payout_acceptance_checks(p_window_days);

  SELECT count(*),
         count(*) FILTER (WHERE status = 'fail'),
         count(*) FILTER (WHERE status = 'warn')
  INTO v_total, v_fail, v_warn FROM _acc_tmp;

  INSERT INTO public.finance_anomaly_alert_states AS s (
    check_key, label, category, channel, severity,
    item_count, exposure, fingerprint, state,
    first_seen_at, last_seen_at, last_changed_at, resolved_at
  )
  SELECT
    'acceptance:' || c.check_key,
    c.title,
    CASE WHEN c.status = 'fail' THEN 'financial_integrity' ELSE 'monitoring' END,
    CASE WHEN c.status = 'fail' THEN 'email' ELSE 'dashboard' END,
    CASE WHEN c.status = 'fail' THEN 'high'
         WHEN c.status = 'warn' THEN 'medium' ELSE 'clean' END,
    CASE WHEN c.status = 'pass' THEN 0 ELSE GREATEST(1, COALESCE(c.observed, 0))::integer END,
    0,
    md5(format('%s|%s|%s', c.check_key, c.status, COALESCE(c.observed, 0))),
    CASE WHEN c.status = 'pass' THEN 'RESOLVED' ELSE 'NEW' END,
    now(), now(), now(),
    CASE WHEN c.status = 'pass' THEN now() ELSE NULL END
  FROM _acc_tmp c
  ON CONFLICT (check_key) DO UPDATE SET
    label = EXCLUDED.label,
    category = EXCLUDED.category,
    channel = EXCLUDED.channel,
    severity = EXCLUDED.severity,
    item_count = EXCLUDED.item_count,
    last_seen_at = now(),
    last_changed_at = CASE WHEN s.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
                           THEN now() ELSE s.last_changed_at END,
    resolved_at = CASE WHEN EXCLUDED.item_count = 0 THEN COALESCE(s.resolved_at, now()) ELSE NULL END,
    acknowledged_at = CASE WHEN s.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
                           THEN NULL ELSE s.acknowledged_at END,
    acknowledged_by = CASE WHEN s.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
                           THEN NULL ELSE s.acknowledged_by END,
    state = CASE
      WHEN EXCLUDED.item_count = 0 THEN 'RESOLVED'
      WHEN s.state = 'RESOLVED' THEN 'NEW'
      WHEN s.acknowledged_at IS NOT NULL AND s.fingerprint = EXCLUDED.fingerprint THEN 'ACKNOWLEDGED'
      ELSE 'ACTIVE'
    END,
    fingerprint = EXCLUDED.fingerprint,
    first_seen_at = CASE WHEN s.state = 'RESOLVED' AND EXCLUDED.item_count > 0
                         THEN now() ELSE s.first_seen_at END;

  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY
           CASE c.status WHEN 'fail' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, c.check_key), '[]'::jsonb)
  INTO v_rows FROM _acc_tmp c;

  IF v_fail > 0 THEN
    INSERT INTO public.system_events (event_type, description, metadata)
    VALUES (
      'report_generation_failed',
      format('Payout acceptance checks: %s failing invariant(s)', v_fail),
      jsonb_build_object('trigger_source', p_trigger_source, 'failing', v_fail, 'warnings', v_warn)
    );
  END IF;

  RETURN jsonb_build_object(
    'scanned_at', now(),
    'trigger_source', p_trigger_source,
    'window_days', p_window_days,
    'total_checks', v_total,
    'failing', v_fail,
    'warnings', v_warn,
    'alerts_enabled', COALESCE(v_enabled, true),
    'notify_channel', CASE WHEN v_fail > 0 THEN 'email' ELSE 'none' END,
    'checks', v_rows
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.run_payout_acceptance_scan(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_payout_acceptance_scan(text, integer) TO service_role;