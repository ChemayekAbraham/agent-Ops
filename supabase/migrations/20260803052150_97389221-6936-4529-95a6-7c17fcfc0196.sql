-- ============================================================
-- Finance alert monitoring architecture (monitoring layer only)
-- ============================================================

-- ---------- config ----------
ALTER TABLE public.finance_anomaly_alert_config
  ADD COLUMN IF NOT EXISTS sms_materiality_ugx numeric NOT NULL DEFAULT 500000,
  ADD COLUMN IF NOT EXISTS email_materiality_ugx numeric NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS historical_after_days integer NOT NULL DEFAULT 7;

-- ---------- scan audit columns ----------
ALTER TABLE public.finance_anomaly_scans
  ADD COLUMN IF NOT EXISTS alert_fingerprint text,
  ADD COLUMN IF NOT EXISTS categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notify_channel text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS notification_reason text,
  ADD COLUMN IF NOT EXISTS notifications_sent jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS financial_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS financial_exposure numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS financial_severity text NOT NULL DEFAULT 'clean',
  ADD COLUMN IF NOT EXISTS action_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fingerprint_repeat boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_finance_anomaly_scans_fingerprint
  ON public.finance_anomaly_scans (alert_fingerprint, scanned_at DESC);

-- ---------- severity ranking helper ----------
CREATE OR REPLACE FUNCTION public.finance_alert_severity_rank(p_severity text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE lower(coalesce(p_severity,'clean'))
    WHEN 'critical' THEN 4
    WHEN 'high' THEN 3
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 1
    ELSE 0 END;
$$;

CREATE OR REPLACE FUNCTION public.finance_alert_rank_severity(p_rank integer)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE coalesce(p_rank,0)
    WHEN 4 THEN 'critical'
    WHEN 3 THEN 'high'
    WHEN 2 THEN 'medium'
    WHEN 1 THEN 'low'
    ELSE 'clean' END;
$$;

-- ---------- alert lifecycle states ----------
CREATE TABLE IF NOT EXISTS public.finance_anomaly_alert_states (
  check_key text PRIMARY KEY,
  label text NOT NULL,
  category text NOT NULL,
  channel text NOT NULL DEFAULT 'dashboard',
  state text NOT NULL DEFAULT 'NEW',
  severity text NOT NULL DEFAULT 'clean',
  item_count integer NOT NULL DEFAULT 0,
  exposure numeric NOT NULL DEFAULT 0,
  fingerprint text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_changed_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  acknowledge_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_anomaly_alert_states_state_check
    CHECK (state IN ('NEW','ACTIVE','ACKNOWLEDGED','RESOLVED','HISTORICAL'))
);

GRANT SELECT, UPDATE ON public.finance_anomaly_alert_states TO authenticated;
GRANT ALL ON public.finance_anomaly_alert_states TO service_role;
ALTER TABLE public.finance_anomaly_alert_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "finance execs read alert states" ON public.finance_anomaly_alert_states;
CREATE POLICY "finance execs read alert states"
ON public.finance_anomaly_alert_states FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
);

DROP POLICY IF EXISTS "finance execs ack alert states" ON public.finance_anomaly_alert_states;
CREATE POLICY "finance execs ack alert states"
ON public.finance_anomaly_alert_states FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'super_admin')
);

DROP TRIGGER IF EXISTS trg_touch_finance_anomaly_alert_states ON public.finance_anomaly_alert_states;
CREATE TRIGGER trg_touch_finance_anomaly_alert_states
BEFORE UPDATE ON public.finance_anomaly_alert_states
FOR EACH ROW EXECUTE FUNCTION public.touch_finance_anomaly_alert_config();

-- ============================================================
-- Detector: classified, category-scoped, materiality-aware
-- ============================================================
CREATE OR REPLACE FUNCTION public.detect_finance_anomalies(p_min_amount numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min numeric;
  v_sms_material numeric;
  v_hist_days integer;
  v_checks jsonb := '[]'::jsonb;
  v_n integer;
  v_amt numeric;
  v_sample jsonb;
  v_categories jsonb;
  v_fin_count integer := 0;
  v_fin_exposure numeric := 0;
  v_fin_rank integer := 0;
  v_total_count integer := 0;
  v_total_exposure numeric := 0;
  v_fingerprint text;
  v_channel text := 'none';
  v_action boolean := false;
BEGIN
  SELECT COALESCE(p_min_amount, min_amount, 1000),
         COALESCE(sms_materiality_ugx, 500000),
         COALESCE(historical_after_days, 7)
  INTO v_min, v_sms_material, v_hist_days
  FROM public.finance_anomaly_alert_config WHERE id = 1;
  v_min := COALESCE(v_min, COALESCE(p_min_amount, 1000));
  v_sms_material := COALESCE(v_sms_material, 500000);
  v_hist_days := COALESCE(v_hist_days, 7);

  -- 1. FINANCIAL INTEGRITY: wallet cache vs strict ledger truth
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
    'key', 'wallet_cache_vs_ledger',
    'label', 'Wallet cache disagrees with ledger',
    'category', 'financial_integrity',
    'channel', CASE WHEN v_n = 0 THEN 'none'
                    WHEN v_amt >= v_sms_material THEN 'sms' ELSE 'email' END,
    'severity', CASE WHEN v_n = 0 THEN 'clean'
                     WHEN v_amt >= v_sms_material THEN 'critical' ELSE 'medium' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- 2. FINANCIAL INTEGRITY: negative wallet buckets
  SELECT count(*),
         COALESCE(sum(abs(LEAST(withdrawable_balance,0)) + abs(LEAST(float_balance,0)) + abs(LEAST(balance,0))), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'withdrawable', withdrawable_balance, 'float', float_balance, 'balance', balance)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallets
  WHERE withdrawable_balance < 0 OR float_balance < 0 OR balance < 0;
  v_checks := v_checks || jsonb_build_object(
    'key', 'negative_wallet_buckets', 'label', 'Negative wallet buckets',
    'category', 'financial_integrity',
    'channel', CASE WHEN v_n = 0 THEN 'none' ELSE 'sms' END,
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'critical' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- 3. FINANCIAL INTEGRITY: unbalanced ledger groups (24h)
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
    'category', 'financial_integrity',
    'channel', CASE WHEN v_n = 0 THEN 'none' ELSE 'sms' END,
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'critical' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- 4. BUSINESS RULE: routing violations (24h)
  SELECT count(*), COALESCE(sum(amount), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'category', category, 'amount', amount, 'reason', reason)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallet_routing_violations WHERE occurred_at >= now() - interval '24 hours';
  v_checks := v_checks || jsonb_build_object(
    'key', 'routing_violations', 'label', 'Wallet routing violations (24h)',
    'category', 'business_rule',
    'channel', CASE WHEN v_n = 0 THEN 'none' ELSE 'email' END,
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'high' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- 5. BUSINESS RULE: unrouted movements (24h)
  SELECT count(*), COALESCE(sum(amount), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'category', category, 'amount', amount)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallet_unrouted_movements WHERE created_at >= now() - interval '24 hours';
  v_checks := v_checks || jsonb_build_object(
    'key', 'unrouted_movements', 'label', 'Unrouted wallet movements (24h)',
    'category', 'business_rule',
    'channel', CASE WHEN v_n = 0 THEN 'none' ELSE 'email' END,
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'high' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- 6. OPERATIONAL: recent ownerless wallet legs
  SELECT count(*), COALESCE(sum(amount), 0),
         COALESCE(jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'category', category, 'created_at', created_at)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.v_general_ledger_operational
  WHERE ledger_scope = 'wallet' AND user_id IS NULL
    AND created_at >= now() - (v_hist_days || ' days')::interval;
  v_checks := v_checks || jsonb_build_object(
    'key', 'orphan_wallet_legs_recent', 'label', 'Ownerless wallet legs (recent)',
    'category', 'operational',
    'channel', CASE WHEN v_n = 0 THEN 'none' ELSE 'email' END,
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'high' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- 7. OPERATIONAL (historical artifact): older ownerless wallet legs
  SELECT count(*), COALESCE(sum(amount), 0),
         COALESCE(jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'category', category, 'created_at', created_at)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.v_general_ledger_operational
  WHERE ledger_scope = 'wallet' AND user_id IS NULL
    AND created_at < now() - (v_hist_days || ' days')::interval;
  v_checks := v_checks || jsonb_build_object(
    'key', 'orphan_wallet_legs_historical', 'label', 'Ownerless wallet legs (historical artifact)',
    'category', 'operational',
    'historical', true,
    'channel', 'dashboard',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'low' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- 8. OPERATIONAL: overdraw clamps (24h)
  SELECT count(*), COALESCE(sum(abs(COALESCE(delta_lost,0))), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'delta_lost', delta_lost, 'trigger_op', trigger_op)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallet_overdraw_events WHERE created_at >= now() - interval '24 hours';
  v_checks := v_checks || jsonb_build_object(
    'key', 'overdraw_events', 'label', 'Wallet overdraw clamps (24h)',
    'category', 'operational',
    'channel', CASE WHEN v_n = 0 THEN 'none' ELSE 'email' END,
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'medium' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- 9. OPERATIONAL: new wallet legs missing bucket label (24h)
  SELECT count(*), COALESCE(sum(amount), 0)
  INTO v_n, v_amt
  FROM public.v_general_ledger_operational
  WHERE ledger_scope = 'wallet' AND wallet_bucket IS NULL
    AND created_at >= now() - interval '24 hours';
  v_checks := v_checks || jsonb_build_object(
    'key', 'wallet_legs_missing_bucket', 'label', 'New wallet legs missing bucket label (24h)',
    'category', 'operational',
    'channel', 'dashboard',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'medium' END,
    'count', v_n, 'amount', v_amt, 'sample', '[]'::jsonb);

  -- 10. COMPARATOR: pivot drift (never counted as financial exposure)
  SELECT count(*), COALESCE(sum(abs(COALESCE(withdrawable_drift,0)) + abs(COALESCE(float_drift,0)) + abs(COALESCE(advance_drift,0))), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'withdrawable_drift', withdrawable_drift, 'float_drift', float_drift, 'advance_drift', advance_drift)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallet_pivot_drift_view
  WHERE abs(COALESCE(withdrawable_drift,0)) >= v_min OR abs(COALESCE(float_drift,0)) >= v_min OR abs(COALESCE(advance_drift,0)) >= v_min;
  v_checks := v_checks || jsonb_build_object(
    'key', 'pivot_drift', 'label', 'Pivot comparator drift (monitoring comparison only)',
    'category', 'comparator',
    'channel', 'dashboard',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'medium' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- 11. MONITORING: comparator reads zero while wallet holds money (view defect)
  SELECT count(*), COALESCE(sum(abs(COALESCE(d.withdrawable_drift,0)) + abs(COALESCE(d.float_drift,0)) + abs(COALESCE(d.advance_drift,0))), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', d.user_id, 'withdrawable_drift', d.withdrawable_drift, 'float_drift', d.float_drift)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallet_pivot_drift_view d
  JOIN public.wallets w ON w.user_id = d.user_id
  JOIN public.v_user_wallet_strict s ON s.user_id = d.user_id
  WHERE (abs(COALESCE(d.withdrawable_drift,0)) >= v_min OR abs(COALESCE(d.float_drift,0)) >= v_min OR abs(COALESCE(d.advance_drift,0)) >= v_min)
    AND abs(w.withdrawable_balance - s.withdrawable) < v_min
    AND abs(w.float_balance - s.float_balance) < v_min
    AND abs(w.advance_balance - s.advance_balance) < v_min;
  v_checks := v_checks || jsonb_build_object(
    'key', 'comparator_view_defect', 'label', 'Comparator flags drift where ledger and cache agree (monitoring defect)',
    'category', 'monitoring',
    'channel', 'dashboard',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'medium' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- 12. PRESENTATION: headline balance does not equal bucket composition
  SELECT count(*), COALESCE(sum(abs(balance - (withdrawable_balance + float_balance))), 0),
         COALESCE(jsonb_agg(jsonb_build_object('user_id', user_id, 'balance', balance, 'withdrawable', withdrawable_balance, 'float', float_balance)), '[]'::jsonb)
  INTO v_n, v_amt, v_sample
  FROM public.wallets
  WHERE abs(COALESCE(balance,0) - (COALESCE(withdrawable_balance,0) + COALESCE(float_balance,0))) >= v_min;
  v_checks := v_checks || jsonb_build_object(
    'key', 'headline_composition_mismatch', 'label', 'Headline balance differs from bucket composition (display)',
    'category', 'presentation',
    'channel', 'dashboard',
    'severity', CASE WHEN v_n = 0 THEN 'clean' ELSE 'low' END,
    'count', v_n, 'amount', v_amt,
    'sample', COALESCE((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_sample) x LIMIT 10) s), '[]'::jsonb));

  -- ---------- category rollups ----------
  WITH c AS (
    SELECT x->>'category' AS category,
           (x->>'count')::integer AS cnt,
           COALESCE((x->>'amount')::numeric, 0) AS amt,
           x->>'severity' AS sev,
           x->>'channel' AS chan
    FROM jsonb_array_elements(v_checks) x
  ), agg AS (
    SELECT category,
           sum(cnt) AS cnt,
           sum(CASE WHEN cnt > 0 THEN amt ELSE 0 END) AS exposure,
           max(CASE WHEN cnt > 0 THEN public.finance_alert_severity_rank(sev) ELSE 0 END) AS sev_rank,
           bool_or(cnt > 0 AND chan = 'sms') AS has_sms,
           bool_or(cnt > 0 AND chan = 'email') AS has_email
    FROM c GROUP BY category
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category', category,
           'count', cnt,
           'exposure', exposure,
           'severity', public.finance_alert_rank_severity(sev_rank),
           'requires_sms', has_sms,
           'requires_email', has_email
         ) ORDER BY category), '[]'::jsonb)
  INTO v_categories FROM agg;

  SELECT COALESCE(sum((x->>'count')::integer), 0),
         COALESCE(sum(CASE WHEN (x->>'count')::integer > 0 THEN COALESCE((x->>'amount')::numeric,0) ELSE 0 END), 0)
  INTO v_total_count, v_total_exposure
  FROM jsonb_array_elements(v_checks) x;

  SELECT COALESCE(sum((x->>'count')::integer), 0),
         COALESCE(sum(CASE WHEN (x->>'count')::integer > 0 THEN COALESCE((x->>'amount')::numeric,0) ELSE 0 END), 0),
         COALESCE(max(CASE WHEN (x->>'count')::integer > 0 THEN public.finance_alert_severity_rank(x->>'severity') ELSE 0 END), 0)
  INTO v_fin_count, v_fin_exposure, v_fin_rank
  FROM jsonb_array_elements(v_checks) x
  WHERE x->>'category' = 'financial_integrity';

  -- ---------- materiality routing ----------
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_checks) x
             WHERE (x->>'count')::integer > 0 AND x->>'channel' = 'sms') THEN
    v_channel := 'sms';
    v_action := true;
  ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(v_checks) x
                WHERE (x->>'count')::integer > 0 AND x->>'channel' = 'email') THEN
    v_channel := 'email';
  ELSIF v_total_count > 0 THEN
    v_channel := 'dashboard';
  END IF;

  -- ---------- deterministic fingerprint ----------
  SELECT md5(string_agg(
           format('%s|%s|%s|%s|%s',
                  x->>'key', x->>'category', x->>'severity',
                  x->>'count',
                  round(COALESCE((x->>'amount')::numeric,0) / 1000)),
           ';' ORDER BY x->>'key'))
  INTO v_fingerprint
  FROM jsonb_array_elements(v_checks) x;

  RETURN jsonb_build_object(
    'scanned_at', now(),
    'min_amount', v_min,
    'sms_materiality_ugx', v_sms_material,
    'severity', public.finance_alert_rank_severity(v_fin_rank),
    'financial_severity', public.finance_alert_rank_severity(v_fin_rank),
    'financial_count', v_fin_count,
    'financial_exposure', v_fin_exposure,
    'anomaly_count', v_total_count,
    'total_exposure', v_total_exposure,
    'action_required', v_action,
    'notify_channel', v_channel,
    'alert_fingerprint', v_fingerprint,
    'categories', v_categories,
    'checks', v_checks
  );
END;
$$;

REVOKE ALL ON FUNCTION public.detect_finance_anomalies(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_finance_anomalies(numeric) TO service_role;

-- ============================================================
-- Scan runner: lifecycle + fingerprint suppression + audit
-- ============================================================
CREATE OR REPLACE FUNCTION public.run_finance_anomaly_scan(p_trigger_source text DEFAULT 'manual')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_report jsonb;
  v_id uuid;
  v_fp text;
  v_prev_fp text;
  v_prev_rank integer := 0;
  v_rank integer;
  v_channel text;
  v_reason text;
  v_repeat boolean := false;
  v_reopened boolean := false;
  v_new_incident boolean := false;
  v_exposure numeric;
  v_prev_exposure numeric := 0;
BEGIN
  v_report := public.detect_finance_anomalies(NULL);
  v_fp := v_report->>'alert_fingerprint';
  v_channel := COALESCE(v_report->>'notify_channel', 'none');
  v_rank := public.finance_alert_severity_rank(v_report->>'financial_severity');
  v_exposure := COALESCE((v_report->>'financial_exposure')::numeric, 0);

  SELECT alert_fingerprint,
         public.finance_alert_severity_rank(financial_severity),
         COALESCE(financial_exposure, 0)
  INTO v_prev_fp, v_prev_rank, v_prev_exposure
  FROM public.finance_anomaly_scans
  ORDER BY scanned_at DESC
  LIMIT 1;

  -- lifecycle state per check
  WITH c AS (
    SELECT x->>'key' AS key,
           x->>'label' AS label,
           x->>'category' AS category,
           COALESCE(x->>'channel','dashboard') AS channel,
           x->>'severity' AS severity,
           (x->>'count')::integer AS cnt,
           COALESCE((x->>'amount')::numeric,0) AS amt,
           COALESCE((x->>'historical')::boolean, false) AS is_hist
    FROM jsonb_array_elements(v_report->'checks') x
  ), up AS (
    INSERT INTO public.finance_anomaly_alert_states AS s (
      check_key, label, category, channel, state, severity, item_count, exposure,
      fingerprint, first_seen_at, last_seen_at, last_changed_at, resolved_at
    )
    SELECT key, label, category, channel,
           CASE WHEN cnt = 0 THEN 'RESOLVED' WHEN is_hist THEN 'HISTORICAL' ELSE 'NEW' END,
           severity, cnt, CASE WHEN cnt > 0 THEN amt ELSE 0 END,
           md5(format('%s|%s|%s|%s', key, severity, cnt, round(amt/1000))),
           now(), now(), now(),
           CASE WHEN cnt = 0 THEN now() ELSE NULL END
    FROM c
    ON CONFLICT (check_key) DO UPDATE SET
      label = EXCLUDED.label,
      category = EXCLUDED.category,
      channel = EXCLUDED.channel,
      severity = EXCLUDED.severity,
      item_count = EXCLUDED.item_count,
      exposure = EXCLUDED.exposure,
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
        WHEN EXCLUDED.state = 'HISTORICAL' THEN 'HISTORICAL'
        WHEN s.state = 'RESOLVED' THEN 'NEW'
        WHEN s.acknowledged_at IS NOT NULL AND s.fingerprint = EXCLUDED.fingerprint THEN 'ACKNOWLEDGED'
        ELSE 'ACTIVE'
      END,
      fingerprint = EXCLUDED.fingerprint,
      first_seen_at = CASE WHEN s.state = 'RESOLVED' AND EXCLUDED.item_count > 0
                           THEN now() ELSE s.first_seen_at END
    RETURNING s.check_key, s.state, s.category, (SELECT cnt FROM c WHERE c.key = s.check_key) AS cnt
  )
  SELECT bool_or(state = 'NEW' AND category = 'financial_integrity' AND cnt > 0)
  INTO v_reopened FROM up;
  v_new_incident := COALESCE(v_reopened, false);

  -- notification decision
  IF v_channel = 'none' THEN
    v_reason := 'clean scan — nothing to report';
  ELSIF v_channel = 'dashboard' THEN
    v_reason := 'dashboard-only findings (comparator/monitoring/presentation/historical)';
  ELSIF v_fp IS NOT NULL AND v_fp = v_prev_fp
        AND v_rank <= v_prev_rank
        AND NOT v_new_incident
        AND abs(v_exposure - v_prev_exposure) < GREATEST(v_prev_exposure * 0.05, 1000) THEN
    v_repeat := true;
    v_channel := 'heartbeat';
    v_reason := 'identical fingerprint, no severity or material exposure change — heartbeat only';
  ELSIF v_rank > v_prev_rank THEN
    v_reason := 'financial severity increased';
  ELSIF v_new_incident THEN
    v_reason := 'new or reopened financial integrity incident';
  ELSE
    v_reason := 'fingerprint changed — materially different findings';
  END IF;

  v_report := v_report
    || jsonb_build_object(
         'notify_channel', v_channel,
         'notification_reason', v_reason,
         'fingerprint_repeat', v_repeat,
         'previous_fingerprint', v_prev_fp
       );

  INSERT INTO public.finance_anomaly_scans (
    trigger_source, severity, anomaly_count, total_exposure, report,
    alert_fingerprint, categories, notify_channel, notification_reason,
    financial_count, financial_exposure, financial_severity,
    action_required, fingerprint_repeat
  )
  VALUES (
    COALESCE(NULLIF(trim(p_trigger_source), ''), 'manual'),
    v_report->>'financial_severity',
    COALESCE((v_report->>'anomaly_count')::integer, 0),
    COALESCE((v_report->>'total_exposure')::numeric, 0),
    v_report,
    v_fp,
    COALESCE(v_report->'categories', '[]'::jsonb),
    v_channel,
    v_reason,
    COALESCE((v_report->>'financial_count')::integer, 0),
    v_exposure,
    v_report->>'financial_severity',
    COALESCE((v_report->>'action_required')::boolean, false),
    v_repeat
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('scan_id', v_id) || v_report;
END;
$$;

REVOKE ALL ON FUNCTION public.run_finance_anomaly_scan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_finance_anomaly_scan(text) TO service_role;

-- ============================================================
-- Acknowledge helper (monitoring layer only)
-- ============================================================
CREATE OR REPLACE FUNCTION public.acknowledge_finance_anomaly_alert(
  p_check_key text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row public.finance_anomaly_alert_states;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
          OR public.has_role(auth.uid(), 'super_admin')) THEN
    RAISE EXCEPTION 'not authorized to acknowledge finance alerts';
  END IF;

  UPDATE public.finance_anomaly_alert_states
  SET state = CASE WHEN item_count = 0 THEN 'RESOLVED' ELSE 'ACKNOWLEDGED' END,
      acknowledged_at = now(),
      acknowledged_by = auth.uid(),
      acknowledge_note = NULLIF(trim(COALESCE(p_note,'')), '')
  WHERE check_key = p_check_key
  RETURNING * INTO v_row;

  IF v_row.check_key IS NULL THEN
    RAISE EXCEPTION 'unknown finance alert key: %', p_check_key;
  END IF;

  RETURN jsonb_build_object('check_key', v_row.check_key, 'state', v_row.state);
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_finance_anomaly_alert(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_finance_anomaly_alert(text, text) TO authenticated;