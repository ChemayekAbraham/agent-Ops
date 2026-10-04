
CREATE TABLE IF NOT EXISTS public.credit_limit_reconciliation_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  cached_bonus_allocations numeric NOT NULL DEFAULT 0,
  expected_bonus_allocations numeric NOT NULL DEFAULT 0,
  bonus_drift numeric NOT NULL DEFAULT 0,
  cached_total_limit numeric NOT NULL DEFAULT 0,
  expected_total_limit numeric NOT NULL DEFAULT 0,
  limit_drift numeric NOT NULL DEFAULT 0,
  cached_float numeric NOT NULL DEFAULT 0,
  ledger_float numeric NOT NULL DEFAULT 0,
  float_drift numeric NOT NULL DEFAULT 0,
  severity text NOT NULL DEFAULT 'low',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid
);

CREATE INDEX IF NOT EXISTS idx_clra_user ON public.credit_limit_reconciliation_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_clra_open ON public.credit_limit_reconciliation_alerts(detected_at DESC) WHERE resolved_at IS NULL;

ALTER TABLE public.credit_limit_reconciliation_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view credit limit drift" ON public.credit_limit_reconciliation_alerts;
CREATE POLICY "Staff can view credit limit drift"
  ON public.credit_limit_reconciliation_alerts FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'operations')
  );

DROP POLICY IF EXISTS "Staff can resolve credit limit drift" ON public.credit_limit_reconciliation_alerts;
CREATE POLICY "Staff can resolve credit limit drift"
  ON public.credit_limit_reconciliation_alerts FOR UPDATE
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'operations')
  );

CREATE OR REPLACE FUNCTION public.detect_credit_limit_reconciliation_drift()
RETURNS TABLE(inserted_alerts int, scanned_users int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_expected_alloc numeric;
  v_alloc_total numeric;
  v_expected_total numeric;
  v_bonus_drift numeric;
  v_limit_drift numeric;
  v_float_drift numeric;
  v_severity text;
  v_inserted int := 0;
  v_scanned int := 0;
  v_last_id uuid;
  v_last_bonus numeric;
  v_last_limit numeric;
  v_last_float numeric;
BEGIN
  FOR r IN
    SELECT
      cal.user_id,
      cal.bonus_from_agent_allocations AS cached_bonus,
      cal.total_limit                   AS cached_total,
      COALESCE(w.float_balance, 0)      AS cached_float,
      COALESCE(s.float_balance, 0)      AS ledger_float
    FROM public.credit_access_limits cal
    LEFT JOIN public.wallets w ON w.user_id = cal.user_id
    LEFT JOIN public.v_user_wallet_strict s ON s.user_id = cal.user_id
    WHERE cal.bonus_from_agent_allocations > 0
       OR COALESCE(w.float_balance, 0) <> 0
       OR EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.agent_id = cal.user_id)
  LOOP
    v_scanned := v_scanned + 1;

    SELECT COALESCE(SUM(amount), 0) INTO v_alloc_total
      FROM public.agent_collections WHERE agent_id = r.user_id;
    v_expected_alloc := LEAST(v_alloc_total * 2, 30000000);

    v_bonus_drift := r.cached_bonus - v_expected_alloc;
    v_expected_total := LEAST(GREATEST(r.cached_total - r.cached_bonus + v_expected_alloc, 0), 30000000);
    v_limit_drift := r.cached_total - v_expected_total;
    v_float_drift := r.cached_float - r.ledger_float;

    IF abs(v_bonus_drift) < 1 AND abs(v_limit_drift) < 1 AND abs(v_float_drift) < 1 THEN
      CONTINUE;
    END IF;

    SELECT id, bonus_drift, limit_drift, float_drift
      INTO v_last_id, v_last_bonus, v_last_limit, v_last_float
      FROM public.credit_limit_reconciliation_alerts
     WHERE user_id = r.user_id AND resolved_at IS NULL
     ORDER BY detected_at DESC LIMIT 1;

    IF v_last_id IS NOT NULL
       AND abs(v_last_bonus - v_bonus_drift) < 1
       AND abs(v_last_limit - v_limit_drift) < 1
       AND abs(v_last_float - v_float_drift) < 1 THEN
      CONTINUE;
    END IF;

    v_severity := CASE
      WHEN GREATEST(abs(v_bonus_drift), abs(v_limit_drift), abs(v_float_drift)) >= 1000000 THEN 'high'
      WHEN GREATEST(abs(v_bonus_drift), abs(v_limit_drift), abs(v_float_drift)) >= 100000 THEN 'medium'
      ELSE 'low'
    END;

    INSERT INTO public.credit_limit_reconciliation_alerts (
      user_id, cached_bonus_allocations, expected_bonus_allocations, bonus_drift,
      cached_total_limit, expected_total_limit, limit_drift,
      cached_float, ledger_float, float_drift, severity, details
    ) VALUES (
      r.user_id, r.cached_bonus, v_expected_alloc, v_bonus_drift,
      r.cached_total, v_expected_total, v_limit_drift,
      r.cached_float, r.ledger_float, v_float_drift, v_severity,
      jsonb_build_object('agent_collections_sum', v_alloc_total)
    );

    v_inserted := v_inserted + 1;

    IF v_severity = 'high' AND to_regclass('public.system_events') IS NOT NULL THEN
      BEGIN
        INSERT INTO public.system_events (event_type, payload, actor_id)
        VALUES (
          'credit_limit.drift_alert.raised',
          jsonb_build_object(
            'user_id', r.user_id,
            'bonus_drift', v_bonus_drift,
            'limit_drift', v_limit_drift,
            'float_drift', v_float_drift,
            'severity', v_severity
          ),
          r.user_id
        );
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_inserted, v_scanned;
END;
$$;

REVOKE ALL ON FUNCTION public.detect_credit_limit_reconciliation_drift() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_credit_limit_reconciliation_drift() TO authenticated, service_role;
