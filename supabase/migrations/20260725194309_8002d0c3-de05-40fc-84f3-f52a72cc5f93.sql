-- 1. Config
CREATE TABLE public.deposit_match_alert_config (
  id integer PRIMARY KEY DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  window_minutes integer NOT NULL DEFAULT 30,
  min_amount numeric NOT NULL DEFAULT 0,
  notify_emails text[] NOT NULL DEFAULT ARRAY['benjamin@welile.com']::text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT deposit_match_alert_config_singleton CHECK (id = 1),
  CONSTRAINT deposit_match_alert_config_window CHECK (window_minutes BETWEEN 5 AND 1440)
);

GRANT SELECT ON public.deposit_match_alert_config TO authenticated;
GRANT ALL ON public.deposit_match_alert_config TO service_role;
ALTER TABLE public.deposit_match_alert_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can read deposit match alert config"
ON public.deposit_match_alert_config FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "CFO and admins can update deposit match alert config"
ON public.deposit_match_alert_config FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

INSERT INTO public.deposit_match_alert_config (id) VALUES (1) ON CONFLICT DO NOTHING;

-- 2. Alerts
CREATE TABLE public.deposit_match_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type text NOT NULL CHECK (alert_type IN ('deposit_unmatched', 'email_receipt_unmatched')),
  subject_id uuid NOT NULL,
  subject_label text,
  user_id uuid,
  amount numeric,
  transaction_reference text,
  age_minutes integer NOT NULL DEFAULT 0,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning', 'high', 'critical')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  notified_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_match_alerts_unique UNIQUE (alert_type, subject_id)
);

CREATE INDEX idx_deposit_match_alerts_open
  ON public.deposit_match_alerts (created_at DESC) WHERE resolved_at IS NULL;

GRANT SELECT, UPDATE ON public.deposit_match_alerts TO authenticated;
GRANT ALL ON public.deposit_match_alerts TO service_role;
ALTER TABLE public.deposit_match_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can read deposit match alerts"
ON public.deposit_match_alerts FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Ops can resolve deposit match alerts"
ON public.deposit_match_alerts FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE TRIGGER trg_deposit_match_alerts_updated_at
BEFORE UPDATE ON public.deposit_match_alerts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_deposit_match_alert_config_updated_at
BEFORE UPDATE ON public.deposit_match_alert_config
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Detector
CREATE OR REPLACE FUNCTION public.detect_deposit_match_failures()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg public.deposit_match_alert_config%ROWTYPE;
  v_cutoff timestamptz;
  v_raised int := 0;
  v_resolved int := 0;
  rec record;
  v_age int;
  v_sev text;
BEGIN
  SELECT * INTO v_cfg FROM public.deposit_match_alert_config WHERE id = 1;
  IF v_cfg.id IS NULL OR v_cfg.enabled = false THEN
    RETURN jsonb_build_object('enabled', false, 'raised', 0, 'resolved', 0);
  END IF;

  v_cutoff := now() - make_interval(mins => v_cfg.window_minutes);

  -- A. Deposit requests still pending past the window with no matching email receipt
  FOR rec IN
    SELECT d.id, d.user_id, d.amount, d.transaction_id, d.created_at,
           coalesce(p.full_name, p.email, d.user_id::text) AS label,
           d.deposit_purpose::text AS purpose
    FROM public.deposit_requests d
    LEFT JOIN public.profiles p ON p.id = d.user_id
    WHERE d.status = 'pending'
      AND d.created_at < v_cutoff
      AND d.created_at > now() - interval '7 days'
      AND coalesce(d.amount, 0) >= v_cfg.min_amount
      AND NOT EXISTS (
        SELECT 1 FROM public.gmail_transactions g
        WHERE g.linked_deposit_request_id = d.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.gmail_transactions g
        WHERE public.normalize_momo_tid(g.transaction_id) <> ''
          AND public.normalize_momo_tid(g.transaction_id)
              = public.normalize_momo_tid(d.transaction_id)
      )
  LOOP
    v_age := GREATEST(0, floor(extract(epoch FROM (now() - rec.created_at)) / 60)::int);
    v_sev := CASE
      WHEN v_age >= v_cfg.window_minutes * 8 THEN 'critical'
      WHEN v_age >= v_cfg.window_minutes * 3 THEN 'high'
      ELSE 'warning' END;

    INSERT INTO public.deposit_match_alerts (
      alert_type, subject_id, subject_label, user_id, amount,
      transaction_reference, age_minutes, severity, details
    ) VALUES (
      'deposit_unmatched', rec.id, rec.label, rec.user_id, rec.amount,
      rec.transaction_id, v_age, v_sev,
      jsonb_build_object('deposit_purpose', rec.purpose, 'submitted_at', rec.created_at,
                         'window_minutes', v_cfg.window_minutes)
    )
    ON CONFLICT (alert_type, subject_id) DO UPDATE SET
      age_minutes = EXCLUDED.age_minutes,
      severity = EXCLUDED.severity,
      details = EXCLUDED.details,
      updated_at = now()
    WHERE public.deposit_match_alerts.resolved_at IS NULL;

    v_raised := v_raised + 1;
  END LOOP;

  -- B. Incoming email receipts past the window that never got attached to a deposit
  FOR rec IN
    SELECT g.id, g.amount, g.transaction_id, g.created_at, g.channel,
           g.counterparty, g.from_name
    FROM public.gmail_transactions g
    WHERE g.direction = 'in'
      AND coalesce(g.amount, 0) >= GREATEST(v_cfg.min_amount, 1)
      AND g.channel IN ('mtn_momo', 'airtel_money')
      AND g.linked_deposit_request_id IS NULL
      AND g.created_at < v_cutoff
      AND g.created_at > now() - interval '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM public.email_routing_history r
        WHERE r.gmail_transaction_id = g.id
          AND coalesce(r.reason, '') NOT ILIKE 'Reversed%'
      )
  LOOP
    v_age := GREATEST(0, floor(extract(epoch FROM (now() - rec.created_at)) / 60)::int);
    v_sev := CASE
      WHEN v_age >= v_cfg.window_minutes * 8 THEN 'critical'
      WHEN v_age >= v_cfg.window_minutes * 3 THEN 'high'
      ELSE 'warning' END;

    INSERT INTO public.deposit_match_alerts (
      alert_type, subject_id, subject_label, amount,
      transaction_reference, age_minutes, severity, details
    ) VALUES (
      'email_receipt_unmatched', rec.id,
      coalesce(nullif(rec.counterparty, ''), rec.from_name, 'Unknown sender'),
      rec.amount, rec.transaction_id, v_age, v_sev,
      jsonb_build_object('channel', rec.channel, 'received_at', rec.created_at,
                         'window_minutes', v_cfg.window_minutes)
    )
    ON CONFLICT (alert_type, subject_id) DO UPDATE SET
      age_minutes = EXCLUDED.age_minutes,
      severity = EXCLUDED.severity,
      details = EXCLUDED.details,
      updated_at = now()
    WHERE public.deposit_match_alerts.resolved_at IS NULL;

    v_raised := v_raised + 1;
  END LOOP;

  -- C. Auto-resolve alerts whose underlying mismatch is gone
  WITH fixed AS (
    UPDATE public.deposit_match_alerts a
    SET resolved_at = now(), updated_at = now()
    WHERE a.resolved_at IS NULL
      AND (
        (a.alert_type = 'deposit_unmatched' AND EXISTS (
          SELECT 1 FROM public.deposit_requests d
          WHERE d.id = a.subject_id AND d.status <> 'pending'))
        OR
        (a.alert_type = 'email_receipt_unmatched' AND EXISTS (
          SELECT 1 FROM public.gmail_transactions g
          WHERE g.id = a.subject_id AND g.linked_deposit_request_id IS NOT NULL))
        OR
        (a.alert_type = 'email_receipt_unmatched' AND EXISTS (
          SELECT 1 FROM public.email_routing_history r
          WHERE r.gmail_transaction_id = a.subject_id
            AND coalesce(r.reason, '') NOT ILIKE 'Reversed%'))
      )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_resolved FROM fixed;

  INSERT INTO public.system_events (event_type, metadata)
  SELECT 'deposit_match_alert_raised', jsonb_build_object(
    'alert_type', a.alert_type, 'subject_id', a.subject_id,
    'subject_label', a.subject_label, 'amount', a.amount,
    'transaction_reference', a.transaction_reference,
    'age_minutes', a.age_minutes, 'severity', a.severity)
  FROM public.deposit_match_alerts a
  WHERE a.resolved_at IS NULL
    AND a.notified_at IS NULL
    AND a.severity IN ('high', 'critical');

  RETURN jsonb_build_object(
    'enabled', true,
    'window_minutes', v_cfg.window_minutes,
    'raised', v_raised,
    'resolved', v_resolved,
    'open', (SELECT count(*) FROM public.deposit_match_alerts WHERE resolved_at IS NULL)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.detect_deposit_match_failures() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_deposit_match_failures() TO service_role;