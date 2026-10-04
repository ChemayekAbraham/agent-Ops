-- ============================================================
-- 1. CONFIG (singleton)
-- ============================================================
CREATE TABLE public.sms_verification_alert_config (
  id integer NOT NULL DEFAULT 1 PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  window_minutes integer NOT NULL DEFAULT 60,
  failure_count_threshold integer NOT NULL DEFAULT 3,
  min_attempts integer NOT NULL DEFAULT 3,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT sms_verification_alert_config_singleton CHECK (id = 1)
);

GRANT SELECT, INSERT, UPDATE ON public.sms_verification_alert_config TO authenticated;
GRANT ALL ON public.sms_verification_alert_config TO service_role;

ALTER TABLE public.sms_verification_alert_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leadership can view sms verification alert config"
ON public.sms_verification_alert_config
FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE POLICY "Finance leadership can update sms verification alert config"
ON public.sms_verification_alert_config
FOR UPDATE TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

INSERT INTO public.sms_verification_alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 2. ALERTS LOG
-- ============================================================
CREATE TABLE public.sms_verification_failure_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  subject_type text NOT NULL,                    -- 'approver' | 'withdrawal'
  subject_id uuid NOT NULL,
  subject_label text,
  dedup_bucket timestamp with time zone NOT NULL, -- hour bucket for de-duplication
  window_start timestamp with time zone NOT NULL,
  window_end timestamp with time zone NOT NULL,
  total_attempts integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  failure_rate_pct numeric NOT NULL DEFAULT 0,
  top_failure_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  severity text NOT NULL DEFAULT 'warning',
  status text NOT NULL DEFAULT 'open',            -- 'open' | 'acknowledged'
  acknowledged_by uuid,
  acknowledged_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT sms_verification_failure_alerts_dedup
    UNIQUE (subject_type, subject_id, dedup_bucket)
);

GRANT SELECT, INSERT, UPDATE ON public.sms_verification_failure_alerts TO authenticated;
GRANT ALL ON public.sms_verification_failure_alerts TO service_role;

ALTER TABLE public.sms_verification_failure_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leadership can view sms verification failure alerts"
ON public.sms_verification_failure_alerts
FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE POLICY "Finance leadership can acknowledge sms verification failure alerts"
ON public.sms_verification_failure_alerts
FOR UPDATE TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE INDEX idx_svfa_status ON public.sms_verification_failure_alerts (status, created_at DESC);
CREATE INDEX idx_svfa_subject ON public.sms_verification_failure_alerts (subject_type, subject_id);

-- ============================================================
-- 3. DETECTOR
-- ============================================================
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
      INSERT INTO public.system_events (event_type, payload)
      VALUES ('sms.verification_failure_alert.raised', jsonb_build_object(
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
      INSERT INTO public.system_events (event_type, payload)
      VALUES ('sms.verification_failure_alert.raised', jsonb_build_object(
        'subject_type', 'withdrawal', 'subject_id', rec.withdrawal_request_id,
        'failed_count', rec.failed, 'total_attempts', v_total, 'failure_rate_pct', v_rate,
        'severity', v_severity));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('enabled', true, 'raised', v_raised,
    'window_start', v_window_start, 'window_end', v_window_end);
END;
$function$;

-- ============================================================
-- 4. METRICS SUMMARY (role-gated)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_sms_verification_metrics(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := now() - make_interval(hours => GREATEST(p_hours, 1));
  v_total int; v_matched int; v_failed int; v_rate numeric;
  v_by_code jsonb; v_top_approvers jsonb; v_top_requests jsonb;
BEGIN
  IF NOT (
    has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT count(*)::int,
         count(*) FILTER (WHERE validation_result = 'matched')::int,
         count(*) FILTER (WHERE validation_result = 'mismatch')::int
    INTO v_total, v_matched, v_failed
  FROM public.payout_claim_sms_audit_log
  WHERE created_at >= v_start;

  v_rate := CASE WHEN v_total > 0 THEN round((v_failed::numeric / v_total) * 100, 2) ELSE 0 END;

  SELECT coalesce(jsonb_agg(c ORDER BY c.n DESC), '[]'::jsonb) INTO v_by_code FROM (
    SELECT coalesce(validation_code, 'unknown') AS code, count(*)::int AS n
    FROM public.payout_claim_sms_audit_log
    WHERE validation_result = 'mismatch' AND created_at >= v_start
    GROUP BY coalesce(validation_code, 'unknown') ORDER BY count(*) DESC LIMIT 10
  ) c;

  SELECT coalesce(jsonb_agg(a ORDER BY a.failed DESC), '[]'::jsonb) INTO v_top_approvers FROM (
    SELECT l.approver_id,
           coalesce(max(l.approver_email), max(p.email), max(p.full_name)) AS label,
           count(*)::int AS failed
    FROM public.payout_claim_sms_audit_log l
    LEFT JOIN public.profiles p ON p.id = l.approver_id
    WHERE l.validation_result = 'mismatch' AND l.approver_id IS NOT NULL AND l.created_at >= v_start
    GROUP BY l.approver_id ORDER BY count(*) DESC LIMIT 10
  ) a;

  SELECT coalesce(jsonb_agg(w ORDER BY w.failed DESC), '[]'::jsonb) INTO v_top_requests FROM (
    SELECT withdrawal_request_id, count(*)::int AS failed
    FROM public.payout_claim_sms_audit_log
    WHERE validation_result = 'mismatch' AND withdrawal_request_id IS NOT NULL AND created_at >= v_start
    GROUP BY withdrawal_request_id ORDER BY count(*) DESC LIMIT 10
  ) w;

  RETURN jsonb_build_object(
    'window_hours', GREATEST(p_hours, 1),
    'total_attempts', v_total, 'matched_count', v_matched, 'failed_count', v_failed,
    'failure_rate_pct', v_rate, 'by_code', v_by_code,
    'top_approvers', v_top_approvers, 'top_requests', v_top_requests
  );
END;
$function$;

-- ============================================================
-- 5. CRON — run detector every 15 minutes
-- ============================================================
SELECT cron.schedule(
  'detect-sms-verification-failures',
  '*/15 * * * *',
  $$ SELECT public.detect_sms_verification_failures(); $$
);