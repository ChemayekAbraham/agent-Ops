-- ============ config ============
CREATE TABLE IF NOT EXISTS public.finance_anomaly_alert_config (
  id integer PRIMARY KEY DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  min_amount numeric NOT NULL DEFAULT 1000,
  notify_emails text[] NOT NULL DEFAULT ARRAY['joshwanda17@gmail.com']::text[],
  notify_phones text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_anomaly_alert_config_singleton CHECK (id = 1)
);

GRANT SELECT ON public.finance_anomaly_alert_config TO authenticated;
GRANT UPDATE ON public.finance_anomaly_alert_config TO authenticated;
GRANT ALL ON public.finance_anomaly_alert_config TO service_role;
ALTER TABLE public.finance_anomaly_alert_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "finance execs read anomaly config" ON public.finance_anomaly_alert_config;
CREATE POLICY "finance execs read anomaly config"
ON public.finance_anomaly_alert_config FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
);

DROP POLICY IF EXISTS "finance execs manage anomaly config" ON public.finance_anomaly_alert_config;
CREATE POLICY "finance execs manage anomaly config"
ON public.finance_anomaly_alert_config FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin'))
WITH CHECK (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin'));

INSERT INTO public.finance_anomaly_alert_config (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.touch_finance_anomaly_alert_config()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_touch_finance_anomaly_alert_config ON public.finance_anomaly_alert_config;
CREATE TRIGGER trg_touch_finance_anomaly_alert_config
BEFORE UPDATE ON public.finance_anomaly_alert_config
FOR EACH ROW EXECUTE FUNCTION public.touch_finance_anomaly_alert_config();

-- ============ scan history ============
CREATE TABLE IF NOT EXISTS public.finance_anomaly_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scanned_at timestamptz NOT NULL DEFAULT now(),
  trigger_source text NOT NULL DEFAULT 'manual',
  severity text NOT NULL DEFAULT 'clean',
  anomaly_count integer NOT NULL DEFAULT 0,
  total_exposure numeric NOT NULL DEFAULT 0,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_recipients text[] NOT NULL DEFAULT ARRAY[]::text[],
  sms_recipients text[] NOT NULL DEFAULT ARRAY[]::text[],
  notified boolean NOT NULL DEFAULT false,
  notify_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.finance_anomaly_scans TO authenticated;
GRANT ALL ON public.finance_anomaly_scans TO service_role;
ALTER TABLE public.finance_anomaly_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "finance execs read anomaly scans" ON public.finance_anomaly_scans;
CREATE POLICY "finance execs read anomaly scans"
ON public.finance_anomaly_scans FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
);

CREATE INDEX IF NOT EXISTS idx_finance_anomaly_scans_scanned_at
  ON public.finance_anomaly_scans (scanned_at DESC);

DROP TRIGGER IF EXISTS trg_touch_finance_anomaly_scans ON public.finance_anomaly_scans;
CREATE TRIGGER trg_touch_finance_anomaly_scans
BEFORE UPDATE ON public.finance_anomaly_scans
FOR EACH ROW EXECUTE FUNCTION public.touch_finance_anomaly_alert_config();

-- ============ detector ============
CREATE OR REPLACE FUNCTION public.detect_finance_anomalies(p_min_amount numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min numeric;
  v_checks jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_exposure numeric := 0;
  v_severity text := 'clean';
  v_n integer;
  v_amt numeric;
  v_sample jsonb;
BEGIN
  v_min := COALESCE(p_min_amount, (SELECT min_amount FROM public.finance_anomaly_alert_config WHERE id = 1), 1000);

  -- 1. wallet cache vs strict ledger view
  WITH d AS (
    SELECT w.user_id,
           (w.withdrawable_balance - s.withdrawable) AS dw,
           (w.float_balance - s.float_balance) AS df,
           (w.advance_balance - s.advance_balance) AS da
    FROM public.wallets w
    JOIN public.v_user_wallet_strict s ON s.user_id = w.user_id
  ), f AS (
    SELECT * FROM d
    WHERE abs(COALESCE(dw,0)) >= v_min OR abs(COALESCE(df,0)) >= v_min OR abs(COALESCE(da,0)) >= v_min
  )
  SELECT count(*),
         COALESCE(sum(abs(COALESCE(dw,0)) + abs(COALESCE(df,0)) + abs(COALESCE(da,0))), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'withdrawable_drift', dw, 'float_drift', df, 'advance_drift', da)
                  ORDER BY abs(COALESCE(dw,0)) + abs(COALESCE(df,0)) + abs(COALESCE(da,0)) DESC), '[]'::jsonb)
  INTO v_n, v_amt, v_sample FROM f;
  v_checks := v_checks || jsonb_build_object(
    'key', 'wallet_cache_vs_ledger', 'label', 'Wallet cache disagrees with ledger',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'critical' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));
  IF v_n > 0 THEN v_count := v_count + v_n; v_exposure := v_exposure + v_amt; v_severity := 'critical'; END IF;

  -- 2. negative wallet buckets
  SELECT count(*),
         COALESCE(sum(abs(LEAST(withdrawable_balance,0)) + abs(LEAST(float_balance,0)) + abs(LEAST(balance,0))), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'withdrawable', withdrawable_balance, 'float', float_balance, 'balance', balance)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallets
  WHERE withdrawable_balance < 0 OR float_balance < 0 OR balance < 0;
  v_checks := v_checks || jsonb_build_object(
    'key', 'negative_wallet_buckets', 'label', 'Negative wallet buckets',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'critical' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));
  IF v_n > 0 THEN v_count := v_count + v_n; v_exposure := v_exposure + v_amt; v_severity := 'critical'; END IF;

  -- 3. pivot comparator drift
  SELECT count(*), COALESCE(sum(abs(COALESCE(withdrawable_drift,0)) + abs(COALESCE(float_drift,0)) + abs(COALESCE(advance_drift,0))), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'withdrawable_drift', withdrawable_drift, 'float_drift', float_drift, 'advance_drift', advance_drift)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallet_pivot_drift_view
  WHERE abs(COALESCE(withdrawable_drift,0)) >= v_min OR abs(COALESCE(float_drift,0)) >= v_min OR abs(COALESCE(advance_drift,0)) >= v_min;
  v_checks := v_checks || jsonb_build_object(
    'key', 'pivot_drift', 'label', 'Wallet cache vs pivot comparator drift',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'high' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));
  IF v_n > 0 THEN
    v_count := v_count + v_n; v_exposure := v_exposure + v_amt;
    IF v_severity <> 'critical' THEN v_severity := 'high'; END IF;
  END IF;

  -- 4. unbalanced ledger groups (last 24h, operational scope)
  WITH g AS (
    SELECT transaction_group_id,
           sum(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END) AS cash_in,
           sum(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END) AS cash_out
    FROM public.v_general_ledger_operational
    WHERE created_at >= now() - interval '24 hours' AND transaction_group_id IS NOT NULL
    GROUP BY transaction_group_id
    HAVING abs(sum(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END)
             - sum(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END)) > 0.01
  )
  SELECT count(*), COALESCE(sum(abs(cash_in - cash_out)), 0),
         COALESCE(jsonb_agg(jsonb_build_object('transaction_group_id', transaction_group_id, 'cash_in', cash_in, 'cash_out', cash_out)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample FROM g;
  v_checks := v_checks || jsonb_build_object(
    'key', 'unbalanced_ledger_groups', 'label', 'Unbalanced ledger transaction groups (24h)',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'critical' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));
  IF v_n > 0 THEN v_count := v_count + v_n; v_exposure := v_exposure + v_amt; v_severity := 'critical'; END IF;

  -- 5. orphan wallet-scope legs (no owner), excluding isolated anomalies
  SELECT count(*), COALESCE(sum(amount), 0),
         COALESCE(jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'category', category, 'created_at', created_at)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.v_general_ledger_operational
  WHERE ledger_scope = 'wallet' AND user_id IS NULL;
  v_checks := v_checks || jsonb_build_object(
    'key', 'orphan_wallet_legs', 'label', 'Wallet-scope ledger legs with no owner',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'critical' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));
  IF v_n > 0 THEN v_count := v_count + v_n; v_exposure := v_exposure + v_amt; v_severity := 'critical'; END IF;

  -- 6. routing violations (24h)
  SELECT count(*), COALESCE(sum(amount), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'category', category, 'amount', amount, 'reason', reason)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallet_routing_violations WHERE occurred_at >= now() - interval '24 hours';
  v_checks := v_checks || jsonb_build_object(
    'key', 'routing_violations', 'label', 'Wallet routing violations (24h)',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'high' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));
  IF v_n > 0 THEN
    v_count := v_count + v_n; v_exposure := v_exposure + v_amt;
    IF v_severity <> 'critical' THEN v_severity := 'high'; END IF;
  END IF;

  -- 7. unrouted movements (24h)
  SELECT count(*), COALESCE(sum(amount), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'category', category, 'amount', amount)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallet_unrouted_movements WHERE created_at >= now() - interval '24 hours';
  v_checks := v_checks || jsonb_build_object(
    'key', 'unrouted_movements', 'label', 'Unrouted wallet movements (24h)',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'high' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));
  IF v_n > 0 THEN
    v_count := v_count + v_n; v_exposure := v_exposure + v_amt;
    IF v_severity <> 'critical' THEN v_severity := 'high'; END IF;
  END IF;

  -- 8. overdraw events (24h)
  SELECT count(*), COALESCE(sum(abs(COALESCE(delta_lost,0))), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'delta_lost', delta_lost, 'trigger_op', trigger_op)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallet_overdraw_events WHERE created_at >= now() - interval '24 hours';
  v_checks := v_checks || jsonb_build_object(
    'key', 'overdraw_events', 'label', 'Wallet overdraw clamps (24h)',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'medium' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));
  IF v_n > 0 THEN
    v_count := v_count + v_n; v_exposure := v_exposure + v_amt;
    IF v_severity NOT IN ('critical','high') THEN v_severity := 'medium'; END IF;
  END IF;

  -- 9. new wallet legs missing bucket label (24h only; legacy backlog excluded)
  SELECT count(*), COALESCE(sum(amount), 0)
  INTO v_n, v_amt
  FROM public.v_general_ledger_operational
  WHERE ledger_scope = 'wallet' AND wallet_bucket IS NULL
    AND created_at >= now() - interval '24 hours';
  v_checks := v_checks || jsonb_build_object(
    'key', 'wallet_legs_missing_bucket', 'label', 'New wallet legs missing bucket label (24h)',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'medium' END,
    'count', v_n, 'amount', v_amt, 'sample', '[]'::jsonb);
  IF v_n > 0 THEN
    v_count := v_count + v_n;
    IF v_severity NOT IN ('critical','high') THEN v_severity := 'medium'; END IF;
  END IF;

  RETURN jsonb_build_object(
    'scanned_at', now(),
    'min_amount', v_min,
    'severity', v_severity,
    'anomaly_count', v_count,
    'total_exposure', v_exposure,
    'checks', v_checks
  );
END;
$$;

REVOKE ALL ON FUNCTION public.detect_finance_anomalies(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_finance_anomalies(numeric) TO service_role;

-- ============ scan runner ============
CREATE OR REPLACE FUNCTION public.run_finance_anomaly_scan(p_trigger_source text DEFAULT 'manual')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_report jsonb;
  v_id uuid;
BEGIN
  v_report := public.detect_finance_anomalies(NULL);

  INSERT INTO public.finance_anomaly_scans (trigger_source, severity, anomaly_count, total_exposure, report)
  VALUES (
    COALESCE(NULLIF(trim(p_trigger_source), ''), 'manual'),
    v_report->>'severity',
    COALESCE((v_report->>'anomaly_count')::integer, 0),
    COALESCE((v_report->>'total_exposure')::numeric, 0),
    v_report
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('scan_id', v_id) || v_report;
END;
$$;

REVOKE ALL ON FUNCTION public.run_finance_anomaly_scan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_finance_anomaly_scan(text) TO service_role;